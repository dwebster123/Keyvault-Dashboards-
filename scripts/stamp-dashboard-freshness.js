#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPORT_URL = 'https://app.primenumber.trade/data/jlp_report.html';
const STRATEGY_KEY = '3x JLP (borrow SOL) + Aster Funding';
const DATA_DIR = path.join(__dirname, '..', 'data');
const STAMP_PATH = path.join(DATA_DIR, 'dashboard-freshness.json');
const LATEST_PATH = path.join(DATA_DIR, 'jlp-strategy-latest.json');

function getEasternParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short'
  }).formatToParts(date);

  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function formatEastern(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(date);
}

function easternDateKey(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parsePercentText(value) {
  const parsed = Number(String(value || '').replace(/[%+,]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function findJsonObjectAfter(html, needle) {
  const start = html.indexOf(needle);
  if (start === -1) throw new Error(`Could not find ${needle}`);

  const braceStart = html.indexOf('{', start);
  if (braceStart === -1) throw new Error(`Could not find chart payload for ${needle}`);

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let i = braceStart; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(braceStart, i + 1);
    }
  }

  throw new Error(`Could not parse chart payload for ${needle}`);
}

function parseSummary(html) {
  const rowPattern = new RegExp(
    `<tr>\\s*<td class="strategy-name">${STRATEGY_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</td>([\\s\\S]*?)</tr>`
  );
  const rowMatch = html.match(rowPattern);
  if (!rowMatch) throw new Error(`Could not find strategy row for ${STRATEGY_KEY}`);

  const cells = [...rowMatch[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
    .map(match => match[1].replace(/<[^>]+>/g, '').trim());

  return {
    strategy: STRATEGY_KEY,
    startDate: cells[1],
    endDate: cells[2],
    cumulative: parsePercentText(cells[3]),
    annualized: parsePercentText(cells[4]),
    sevenDayRollingApy: parsePercentText(cells[5]),
    thirtyDayRollingApy: parsePercentText(cells[6]),
    ninetyDayRollingApy: parsePercentText(cells[7])
  };
}

function parsePoints(html) {
  const option = JSON.parse(findJsonObjectAfter(html, 'chart2.setOption('));
  const labels = option?.xAxis?.data || [];
  const series = option?.series?.find(item => item.name === STRATEGY_KEY);
  if (!Array.isArray(labels) || !Array.isArray(series?.data)) {
    throw new Error(`Could not parse chart points for ${STRATEGY_KEY}`);
  }

  return labels.map((date, index) => ({
    date,
    roi: Number(series.data[index])
  })).filter(point => point.date && Number.isFinite(point.roi));
}

async function fetchReport() {
  if (process.env.PRIME_REPORT_HTML_FILE) {
    return fs.readFileSync(process.env.PRIME_REPORT_HTML_FILE, 'utf8');
  }

  try {
    const response = await fetch(REPORT_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  } catch (error) {
    console.warn(`[dashboard-stamp] Node fetch failed (${error.cause?.code || error.message}); retrying with curl.`);
    return execFileSync('curl', ['-fsSL', REPORT_URL], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function main() {
  const onlyAtFive = process.argv.includes('--only-at-5pm-et');
  const now = new Date();
  const eastern = getEasternParts(now);

  if (onlyAtFive && Number(eastern.hour) !== 17) {
    console.log(`[dashboard-stamp] Skipping: current Eastern hour is ${eastern.hour}, not 17.`);
    return;
  }

  if (onlyAtFive) {
    const existingStamp = readJson(STAMP_PATH);
    const existingStampDate = existingStamp?.stampedAt
      ? easternDateKey(getEasternParts(new Date(existingStamp.stampedAt)))
      : null;
    const currentEasternDate = easternDateKey(eastern);

    if (existingStampDate === currentEasternDate) {
      console.log(`[dashboard-stamp] Skipping: ${currentEasternDate} is already stamped.`);
      return;
    }
  }

  const html = await fetchReport();
  const summary = parseSummary(html);
  const points = parsePoints(html);
  const sourceReportLastUpdated = html.match(/Last Updated:\s*([^<]+)/)?.[1]?.trim() || null;

  const latest = {
    ...summary,
    points,
    fetchedAt: now.toISOString()
  };

  const stamp = {
    label: 'KeyVault investor dashboard daily stamp',
    schedule: 'Daily at 5:00 PM America/New_York',
    stampedAt: now.toISOString(),
    stampedAtEastern: formatEastern(now),
    sourceReportUrl: REPORT_URL,
    sourceReportLastUpdated,
    strategy: STRATEGY_KEY,
    summary
  };

  writeJson(LATEST_PATH, latest);
  writeJson(STAMP_PATH, stamp);

  console.log(`[dashboard-stamp] Wrote ${path.relative(process.cwd(), STAMP_PATH)}`);
  console.log(`[dashboard-stamp] Wrote ${path.relative(process.cwd(), LATEST_PATH)}`);
  console.log(`[dashboard-stamp] ${stamp.stampedAtEastern}`);
}

main().catch(error => {
  console.error(`[dashboard-stamp] ${error.stack || error.message}`);
  process.exit(1);
});
