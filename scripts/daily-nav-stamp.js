#!/usr/bin/env node
/**
 * Daily NAV Stamp — Official 5 PM EST vault valuation
 * 
 * Fetches current vault data from Prime Number Trade API,
 * applies normalization ratio to bridge old public vault → new private vault,
 * appends to official-nav-history.json with deduplication.
 * 
 * Run daily at 5:00 PM EST via cron.
 * No external dependencies — uses built-in fetch.
 * 
 * NORMALIZATION CONTEXT:
 * KV was originally in Prime Number's public vault (share price $0.9626 → $1.19).
 * Migrated to private custom vault (PN_KV1) around Jan 2026 — share price reset to ~$1.00.
 * Ratio 1.1909 bridges the gap so the performance track record is continuous.
 * Historical data (public-vault-spreadsheet) is already at the correct scale.
 * Only new API/drift data needs × 1.1909.
 */

const fs = require('fs');
const path = require('path');

const VAULT_URL = 'https://app.primenumber.trade/data/PN_KV1.json';
const NORMALIZATION_RATIO = 1.1909;

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

  // 1. Fetch current vault data
  const vaultRes = await fetch(VAULT_URL);
  if (!vaultRes.ok) throw new Error(`Failed to fetch vault data: ${vaultRes.status}`);
  const vault = await vaultRes.json();

  if (typeof vault.SharePrice !== 'number' || vault.SharePrice <= 0) {
    throw new Error(`Invalid SharePrice from API: ${vault.SharePrice}`);
  }
  if (typeof vault.tvl !== 'number' || vault.tvl <= 0) {
    throw new Error(`Invalid TVL from API: ${vault.tvl}`);
  }

  const rawSharePrice = vault.SharePrice;
  const normalizedSharePrice = rawSharePrice * NORMALIZATION_RATIO;

  console.log(`[NAV Stamp] Vault data fetched — Raw: ${rawSharePrice.toFixed(6)}, Normalized: ${normalizedSharePrice.toFixed(6)}, TVL: $${vault.tvl.toLocaleString()}`);

  // 2. Build today's record — use EST date (5 PM EST = official valuation time)
  const todayDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD format

  const record = {
    date: todayDate,
    timestamp: new Date().toISOString(),
    SharePrice: normalizedSharePrice,
    rawSharePrice: rawSharePrice,
    normalizationRatio: NORMALIZATION_RATIO,
    tvl: vault.tvl,
    source_update_time: vault.update_time_utc || new Date().toISOString(),
  };

  // 3. Load local history, deduplicate, append
  const history = loadHistory();
  const existingIdx = history.findIndex(h => h.date === todayDate);

  if (existingIdx >= 0) {
    history[existingIdx] = record;
    console.log(`[NAV Stamp] Updated existing entry for ${todayDate}`);
  } else {
    history.push(record);
    console.log(`[NAV Stamp] Added new entry for ${todayDate}`);
  }

  // 4. Sort by date ascending
  history.sort((a, b) => a.date.localeCompare(b.date));

  // 5. Sanity check — normalized price should be in reasonable range
  const lastFewPrices = history.slice(-5).map(h => h.SharePrice);
  const avg = lastFewPrices.reduce((a, b) => a + b, 0) / lastFewPrices.length;
  if (Math.abs(normalizedSharePrice - avg) / avg > 0.05) {
    console.warn(`[NAV Stamp] ⚠️ WARNING: Today's price $${normalizedSharePrice.toFixed(6)} deviates >5% from recent average $${avg.toFixed(6)}`);
  }

  // 6. Write file
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(NAV_FILE, JSON.stringify(history, null, 2));
  console.log(`[NAV Stamp] Saved ${history.length} records to ${NAV_FILE}`);

  // 7. Day-over-day change
  const todayIdx = history.findIndex(h => h.date === todayDate);
  let dayChange = null;
  if (todayIdx > 0) {
    const prev = history[todayIdx - 1];
    const prevPrice = prev.SharePrice;
    if (prevPrice && prevPrice > 0) {
      dayChange = ((record.SharePrice - prevPrice) / prevPrice) * 100;
    }
  }

  // 8. Summary
  console.log(`\n=== OFFICIAL NAV — ${todayDate} ===`);
  console.log(`Normalized:   $${record.SharePrice.toFixed(6)}`);
  console.log(`Raw:          $${record.rawSharePrice.toFixed(6)}`);
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
