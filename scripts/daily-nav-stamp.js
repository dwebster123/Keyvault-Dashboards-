#!/usr/bin/env node
/**
 * Daily NAV Stamp — Official 5 PM EST vault valuation
 *
 * The Prime Number Trade API returns the raw private vault SharePrice
 * (around ~1.00x). To convert to the public-equivalent NAV, we multiply
 * by NORMALIZATION_RATIO (1.1909), bridging the gap between the private
 * vault's internal accounting and the public vault's share price history.
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

function getESTDate(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
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
  const now = new Date();
  const todayDate = getESTDate(now);

  const record = {
    date: todayDate,
    timestamp: now.toISOString(),
    SharePrice: normalizedSharePrice,
    rawSharePrice: rawSharePrice,
    normalizationRatio: NORMALIZATION_RATIO,
    tvl: vault.tvl,
    source_update_time: vault.update_time_utc || now.toISOString(),
  };

  // 3. Load local history, validate TVL, deduplicate, append
  const history = loadHistory();

  // TVL validation: skip if zero/negative, warn if >40% drop
  if (vault.tvl <= 0) {
    console.error(`[NAV Stamp] SKIPPING: TVL is ${vault.tvl} (zero or negative)`);
    process.exit(1);
  }
  if (history.length > 0) {
    const prevEntry = history[history.length - 1];
    if (prevEntry.tvl && prevEntry.tvl > 0) {
      const dropPct = (prevEntry.tvl - vault.tvl) / prevEntry.tvl;
      if (dropPct > 0.40) {
        console.warn(`[NAV Stamp] WARNING: TVL dropped ${(dropPct * 100).toFixed(1)}% from $${prevEntry.tvl.toLocaleString()} to $${vault.tvl.toLocaleString()} — large withdrawals may explain this`);
      }
    }
  }

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
  const todayIdx = history.findIndex(h => h.date === todayDate);
  const lastFewPrices = history.slice(-5).map(h => h.SharePrice);
  const avg = lastFewPrices.reduce((a, b) => a + b, 0) / lastFewPrices.length;
  if (Math.abs(normalizedSharePrice - avg) / avg > 0.05) {
    console.warn(`[NAV Stamp] WARNING: Today's price $${normalizedSharePrice.toFixed(6)} deviates >5% from recent average $${avg.toFixed(6)}`);
  }

  // 6. Write file
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(NAV_FILE, JSON.stringify(history, null, 2));
  console.log(`[NAV Stamp] Saved ${history.length} records to ${NAV_FILE}`);

  // 7. Day-over-day change
  let dayChange = null;
  if (todayIdx > 0) {
    const prev = history[todayIdx - 1];
    const prevPrice = prev.SharePrice;
    if (prevPrice && prevPrice > 0) {
      dayChange = ((normalizedSharePrice - prevPrice) / prevPrice) * 100;
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
