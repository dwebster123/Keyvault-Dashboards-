#!/usr/bin/env node
/**
 * Daily NAV Stamp — Official 5 PM EST vault valuation
 * 
 * Fetches current vault data from Prime Number Trade API,
 * appends to official-nav-history.json with deduplication.
 * 
 * Run daily at 5:00 PM EST via cron.
 * No external dependencies — uses built-in fetch.
 */

const fs = require('fs');
const path = require('path');

const VAULT_URL = 'https://app.primenumber.trade/data/PN_KV1.json';
const HISTORY_URL = 'https://app.primenumber.trade/data/PN_KV1_history.json';

const DATA_DIR = path.join(__dirname, '..', 'data');
const NAV_FILE = path.join(DATA_DIR, 'official-nav-history.json');

function loadHistory() {
  try {
    if (fs.existsSync(NAV_FILE)) {
      return JSON.parse(fs.readFileSync(NAV_FILE, 'utf-8'));
    }
  } catch (e) {
    console.warn(`[NAV Stamp] Error loading history: ${e.message}`);
  }
  return [];
}

async function main() {
  console.log(`[NAV Stamp] ${new Date().toISOString()} — Starting daily NAV stamp`);

  // Note: HELIUS_KEY may be passed by cron but is not needed here
  if (process.env.HELIUS_KEY) {
    console.log('[NAV Stamp] HELIUS_KEY present but not used — fetching from Prime Number API');
  }

  // 1. Fetch current vault data
  const vaultRes = await fetch(VAULT_URL);
  if (!vaultRes.ok) throw new Error(`Failed to fetch vault data: ${vaultRes.status}`);
  const vault = await vaultRes.json();

  // Apply normalization ratio — the vault's inception share price was ~0.9626,
  // and historical tracking uses a normalized basis so share price reflects
  // cumulative performance from inception. Ratio = 1.1909 (from Drift on-chain data).
  const NORMALIZATION_RATIO = 1.1909;
  const rawSharePrice = vault.SharePrice;
  const normalizedSharePrice = rawSharePrice * NORMALIZATION_RATIO;

  console.log(`[NAV Stamp] Vault data fetched — Raw: ${rawSharePrice}, Normalized: ${normalizedSharePrice.toFixed(6)}, TVL: ${vault.tvl}`);

  // 2. Fetch history (for reference/logging)
  let remoteHistory = [];
  try {
    const histRes = await fetch(HISTORY_URL);
    if (histRes.ok) {
      remoteHistory = await histRes.json();
      console.log(`[NAV Stamp] Remote history: ${remoteHistory.length} entries`);
    }
  } catch (e) {
    console.warn(`[NAV Stamp] Could not fetch remote history: ${e.message}`);
  }

  // 3. Build today's record
  const now = new Date();
  const todayDate = now.toISOString().split('T')[0];

  const record = {
    date: todayDate,
    timestamp: now.toISOString(),
    SharePrice: normalizedSharePrice,
    rawSharePrice: rawSharePrice,
    normalizationRatio: NORMALIZATION_RATIO,
    tvl: vault.tvl,
    source_update_time: vault.update_time_utc,
  };

  // 4. Load local history, deduplicate, append
  const history = loadHistory();
  const existingIdx = history.findIndex(h => h.date === todayDate);

  if (existingIdx >= 0) {
    history[existingIdx] = record;
    console.log(`[NAV Stamp] Updated existing entry for ${todayDate}`);
  } else {
    history.push(record);
    console.log(`[NAV Stamp] Added new entry for ${todayDate}`);
  }

  // 5. Sort by date ascending
  history.sort((a, b) => a.date.localeCompare(b.date));

  // 6. Write file
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(NAV_FILE, JSON.stringify(history, null, 2));
  console.log(`[NAV Stamp] Saved ${history.length} records to ${NAV_FILE}`);

  // 7. Day-over-day change
  const todayIdx = history.findIndex(h => h.date === todayDate);
  let dayChange = null;
  if (todayIdx > 0) {
    const prev = history[todayIdx - 1];
    const prevPrice = prev.sharePrice ?? prev.SharePrice;
    if (prevPrice) {
      dayChange = ((record.SharePrice - prevPrice) / prevPrice) * 100;
    }
  }

  // 8. Summary
  console.log(`\n=== OFFICIAL NAV — ${todayDate} ===`);
  console.log(`Share Price:  $${record.SharePrice.toFixed(6)} (raw: $${record.rawSharePrice.toFixed(6)})`);
  console.log(`TVL:          $${record.tvl.toLocaleString()}`);
  console.log(`Source Time:  ${record.source_update_time}`);
  if (dayChange !== null) {
    console.log(`Day Change:   ${dayChange >= 0 ? '+' : ''}${dayChange.toFixed(4)}%`);
  } else {
    console.log(`Day Change:   N/A (no previous entry)`);
  }
}

main().catch(err => {
  console.error(`[NAV Stamp] FATAL: ${err.message}`);
  process.exit(1);
});
