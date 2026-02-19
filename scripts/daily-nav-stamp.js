#!/usr/bin/env node
/**
 * Daily NAV Stamp — Official 5 PM EST vault valuation
 *
 * Two data sources:
 *   - PUBLIC vault (Drift JLP Hedge Vault): share price / APY / ROI graph
 *     Address: 2dNSa3fBPMoxcs46NhtdLeTJuLasDt6VYNG4vopa7mWw
 *   - PRIVATE vault (Prime Number KV1): TVL / AUM display only
 *     API: https://app.primenumber.trade/data/PN_KV1.json
 *
 * The public vault represents the full strategy track record (382 days).
 * The private vault is KV's actual investor capital (~$3.34M).
 *
 * Calibration log (PROFIT_PREMIUM):
 *   2026-02-18: actual TVL $11.4M / netDeposits $10.562M = 1.0795
 *   Recalibrate monthly: check Drift UI TVL, update PROFIT_PREMIUM below.
 */

const fs = require('fs');
const path = require('path');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { Wallet } = require('@coral-xyz/anchor');
const { getDriftVaultProgram } = require('@drift-labs/vaults-sdk');

// Public vault (APY / share price / graph)
const PUBLIC_VAULT_ADDRESS = '2dNSa3fBPMoxcs46NhtdLeTJuLasDt6VYNG4vopa7mWw';
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=86b538c8-91f4-4ae5-95ec-4392a2fbecaf';
const PROFIT_PREMIUM = 1.0795; // Recalibrate monthly

// Private vault (TVL / AUM only)
const PRIVATE_VAULT_URL = 'https://app.primenumber.trade/data/PN_KV1.json';
const NORMALIZATION_RATIO = 1.1909;

const DATA_DIR = path.join(__dirname, '..', 'data');
const NAV_FILE = path.join(DATA_DIR, 'official-nav-history.json');

function loadHistory() {
  try {
    if (fs.existsSync(NAV_FILE)) return JSON.parse(fs.readFileSync(NAV_FILE, 'utf-8'));
  } catch (e) { console.warn(`[NAV Stamp] Load error: ${e.message}`); }
  return [];
}

function getESTDate(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function fetchPublicVaultSharePrice() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const wallet = new Wallet(Keypair.generate());
  const program = getDriftVaultProgram(connection, wallet);
  const vault = await program.account.vault.fetch(new PublicKey(PUBLIC_VAULT_ADDRESS));

  const totalSharesRaw = vault.totalShares.toNumber();
  const netDepositsRaw = vault.netDeposits.toNumber();
  const basePriceRaw = netDepositsRaw / totalSharesRaw;
  const sharePrice = basePriceRaw * PROFIT_PREMIUM;

  return { sharePrice, basePriceRaw, profitPremium: PROFIT_PREMIUM };
}

async function fetchPrivateVaultTVL() {
  try {
    const res = await fetch(PRIVATE_VAULT_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      tvl: data.tvl,
      rawSharePrice: data.SharePrice,
    };
  } catch (e) {
    console.warn(`[NAV Stamp] Private vault TVL fetch failed: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log(`[NAV Stamp] ${new Date().toISOString()} — Starting`);

  // Fetch both sources in parallel
  const [publicVault, privateVault] = await Promise.all([
    fetchPublicVaultSharePrice(),
    fetchPrivateVaultTVL(),
  ]);

  const sharePrice = publicVault.sharePrice;
  const tvl = privateVault?.tvl ?? null;

  console.log(`[NAV Stamp] Public vault share price: $${sharePrice.toFixed(6)} (base: $${publicVault.basePriceRaw.toFixed(6)})`);
  if (tvl) console.log(`[NAV Stamp] Private vault TVL (KV1): $${tvl.toLocaleString()}`);

  const now = new Date();
  const todayDate = getESTDate(now);

  const record = {
    date: todayDate,
    timestamp: now.toISOString(),
    SharePrice: sharePrice,                        // Public vault — used for APY / ROI graph
    basePriceRaw: publicVault.basePriceRaw,
    profitPremium: publicVault.profitPremium,
    tvl: tvl,                                      // Private vault KV1 — used for AUM display
    rawSharePrice: privateVault?.rawSharePrice ?? null,
    source: 'public-drift-vault + private-kv1-tvl',
  };

  const history = loadHistory();

  const existingIdx = history.findIndex(h => h.date === todayDate);
  if (existingIdx >= 0) {
    history[existingIdx] = record;
    console.log(`[NAV Stamp] Updated entry for ${todayDate}`);
  } else {
    history.push(record);
    console.log(`[NAV Stamp] Added entry for ${todayDate}`);
  }

  history.sort((a, b) => a.date.localeCompare(b.date));

  // Price deviation check
  const todayIdx = history.findIndex(h => h.date === todayDate);
  const lastFew = history.slice(Math.max(0, todayIdx - 4), todayIdx).map(h => h.SharePrice).filter(Boolean);
  if (lastFew.length > 0) {
    const avg = lastFew.reduce((a, b) => a + b, 0) / lastFew.length;
    const dev = Math.abs(sharePrice - avg) / avg;
    if (dev > 0.05) console.warn(`[NAV Stamp] WARNING: Price deviates ${(dev*100).toFixed(1)}% from 5-day avg`);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(NAV_FILE, JSON.stringify(history, null, 2));
  console.log(`[NAV Stamp] Saved ${history.length} records.`);

  let dayChange = null;
  if (todayIdx > 0) {
    const prev = history[todayIdx - 1];
    if (prev?.SharePrice > 0) dayChange = ((sharePrice - prev.SharePrice) / prev.SharePrice) * 100;
  }

  console.log(`\n=== NAV STAMP — ${todayDate} ===`);
  console.log(`Share Price: $${sharePrice.toFixed(6)}  (public vault — APY/graph)`);
  if (tvl) console.log(`TVL (KV1):   $${tvl.toLocaleString()}  (private vault — AUM display)`);
  if (dayChange !== null) console.log(`Day Change:  ${dayChange >= 0 ? '+' : ''}${dayChange.toFixed(4)}%`);
}

main().catch(err => {
  console.error(`[NAV Stamp] FATAL: ${err.message}`);
  process.exit(1);
});
