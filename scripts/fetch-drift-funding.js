#!/usr/bin/env node
// Fetch Drift funding rate data from S3 (server-side, no CORS issues)
// Lists available dates from S3 and fetches the most recent 90 days with data.
// Outputs: ../data/drift-funding-rates.json

const fs = require('fs');
const path = require('path');

const MARKETS = ['SOL-PERP', 'BTC-PERP', 'ETH-PERP'];
const MAX_DAYS = 90;
const BASE = 'https://drift-historical-data-v2.s3.eu-west-1.amazonaws.com';
const PROGRAM = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';

// List available date keys from S3 for a market+year
async function listDates(market, year) {
  const prefix = `program/${PROGRAM}/market/${market}/fundingRateRecords/${year}/`;
  const url = `${BASE}/?prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
  try {
    const res = await fetch(url);
    const xml = await res.text();
    const dates = [];
    const re = /<Key>[^<]*\/(\d{8})<\/Key>/g;
    let m;
    while ((m = re.exec(xml))) dates.push(m[1]);
    return dates;
  } catch { return []; }
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  const frIdx = headers.indexOf('fundingRate');
  if (frIdx < 0) return [];
  return lines.slice(1).map(l => parseFloat(l.split(',')[frIdx])).filter(v => !isNaN(v));
}

async function fetchDay(market, dateStr) {
  const year = dateStr.slice(0, 4);
  const url = `${BASE}/program/${PROGRAM}/market/${market}/fundingRateRecords/${year}/${dateStr}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    const rates = parseCSV(text);
    if (!rates.length) return null;
    const avgRate = rates.reduce((s, r) => s + r, 0) / rates.length;
    const dateFormatted = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
    return {
      date: dateFormatted,
      avgRate: parseFloat(avgRate.toFixed(8)),
      annualizedPct: parseFloat((avgRate * 24 * 365 * 100).toFixed(4))
    };
  } catch { return null; }
}

async function main() {
  const result = { lastUpdated: new Date().toISOString(), markets: {} };

  for (const market of MARKETS) {
    console.log(`Fetching ${market}...`);

    // List available dates from recent years
    let allDates = [];
    for (const year of [2024, 2025, 2026]) {
      const dates = await listDates(market, year);
      allDates = allDates.concat(dates);
    }
    allDates.sort();

    // Take the most recent MAX_DAYS
    const recentDates = allDates.slice(-MAX_DAYS);
    console.log(`  Found ${allDates.length} total days, fetching last ${recentDates.length}...`);

    const entries = [];
    // Batch 15 at a time
    for (let i = 0; i < recentDates.length; i += 15) {
      const batch = recentDates.slice(i, i + 15);
      const results = await Promise.all(batch.map(d => fetchDay(market, d)));
      results.forEach(r => { if (r) entries.push(r); });
    }
    entries.sort((a, b) => a.date.localeCompare(b.date));
    result.markets[market] = entries;
    console.log(`  ${market}: ${entries.length} days of data`);
  }

  const outPath = path.join(__dirname, '..', 'data', 'drift-funding-rates.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nWritten to ${outPath}`);
  console.log(`Date range: ${Object.values(result.markets).flat().map(e=>e.date).sort()[0]} to ${Object.values(result.markets).flat().map(e=>e.date).sort().pop()}`);
}

main().catch(e => { console.error(e); process.exit(1); });
