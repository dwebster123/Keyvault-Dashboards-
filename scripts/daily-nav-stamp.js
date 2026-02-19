#!/usr/bin/env node
/**
 * Daily NAV Stamp — Official 5 PM EST vault valuation
 *
 * Now uses the PUBLIC Drift vault (JLP Hedge Vault by PrimeNumber):
 * Address: 2dNSa3fBPMoxcs46NhtdLeTJuLasDt6VYNG4vopa7mWw
 *
 * Share price = TVL / totalShares (both from on-chain + Drift UI)
 *
 * Methodology:
 *   - `netDeposits_raw / totalShares_raw` gives the cost-basis share price
 *   - Actual price is higher by ~PROFIT_PREMIUM (trading profits accumulated over time)
 *   - PROFIT_PREMIUM = actual TVL / net deposits (calibrated monthly from Drift UI)
 *
 * Calibration log:
 *   2026-02-18: actual TVL = $11.4M, netDeposits = $10.56M → premium = 1.0795
 *
 * Run daily at 5:00 PM EST via cron.
 */

const fs = require('fs');
const path = require('path');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { Wallet } = require('@coral-xyz/anchor');
const { getDriftVaultProgram } = require('@drift-labs/vaults-sdk');

// --- Config ---
const VAULT_ADDRESS = '2dNSa3fBPMoxcs46NhtdLeTJuLasDt6VYNG4vopa7mWw';
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=86b538c8-91f4-4ae5-95ec-4392a2fbecaf';

// Profit premium = actual TVL / net deposits on chain
// Recalibrate monthly: check Drift UI TVL, divide by (netDeposits_raw/1e6)
// 2026-02-18: TVL $11.4M / netDeposits $10.562M = 1.0795
const PROFIT_PREMIUM = 1.0795;

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

async function fetchVaultData() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const wallet = new Wallet(Keypair.generate());
  const program = getDriftVaultProgram(connection, wallet);

  const vault = await program.account.vault.fetch(new PublicKey(VAULT_ADDRESS));

  const totalSharesRaw = vault.totalShares.toNumber();
  const netDepositsRaw = vault.netDeposits.toNumber();
  const totalDepositsRaw = vault.totalDeposits.toNumber();
  const totalWithdrawsRaw = vault.totalWithdraws.toNumber();

  // Cost-basis share price (no profit premium applied)
  const basePriceRaw = netDepositsRaw / totalSharesRaw;

  // Actual share price = base × premium (accounts for trading profits in vault equity)
  const sharePrice = basePriceRaw * PROFIT_PREMIUM;

  // TVL estimate = net deposits × premium (rough, actual from Drift UI is more precise)
  const netDepositsUSD = netDepositsRaw / 1e6; // USDC has 6 decimals relative to shares
  const tvlEstimate = netDepositsUSD * PROFIT_PREMIUM;

  return {
    sharePrice,
    basePriceRaw,
    netDepositsUSD,
    tvlEstimate,
    totalSharesRaw,
    profitPremium: PROFIT_PREMIUM,
    vaultAddress: VAULT_ADDRESS,
  };
}

async function main() {
  console.log(`[NAV Stamp] ${new Date().toISOString()} — Fetching public vault data on-chain`);

  const vaultData = await fetchVaultData();

  console.log(`[NAV Stamp] Base price (deposits/shares): $${vaultData.basePriceRaw.toFixed(6)}`);
  console.log(`[NAV Stamp] Share price (with premium):   $${vaultData.sharePrice.toFixed(6)}`);
  console.log(`[NAV Stamp] TVL estimate:                 $${vaultData.tvlEstimate.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);

  const now = new Date();
  const todayDate = getESTDate(now);

  const record = {
    date: todayDate,
    timestamp: now.toISOString(),
    SharePrice: vaultData.sharePrice,
    basePriceRaw: vaultData.basePriceRaw,
    profitPremium: vaultData.profitPremium,
    tvl: Math.round(vaultData.tvlEstimate),
    source: 'drift-onchain-public-vault',
    vaultAddress: VAULT_ADDRESS,
  };

  const history = loadHistory();

  // TVL sanity check
  if (history.length > 0) {
    const prevEntry = history[history.length - 1];
    if (prevEntry.tvl && prevEntry.tvl > 0) {
      const dropPct = (prevEntry.tvl - record.tvl) / prevEntry.tvl;
      if (dropPct > 0.40) {
        console.warn(`[NAV Stamp] WARNING: TVL dropped ${(dropPct * 100).toFixed(1)}%`);
      }
    }
  }

  // Deduplicate
  const existingIdx = history.findIndex(h => h.date === todayDate);
  if (existingIdx >= 0) {
    history[existingIdx] = record;
    console.log(`[NAV Stamp] Updated existing entry for ${todayDate}`);
  } else {
    history.push(record);
    console.log(`[NAV Stamp] Added new entry for ${todayDate}`);
  }

  history.sort((a, b) => a.date.localeCompare(b.date));

  // Price deviation check
  const todayIdx = history.findIndex(h => h.date === todayDate);
  const lastFew = history.slice(Math.max(0, todayIdx - 4), todayIdx).map(h => h.SharePrice).filter(Boolean);
  if (lastFew.length > 0) {
    const avg = lastFew.reduce((a, b) => a + b, 0) / lastFew.length;
    const dev = Math.abs(vaultData.sharePrice - avg) / avg;
    if (dev > 0.05) {
      console.warn(`[NAV Stamp] WARNING: Price $${vaultData.sharePrice.toFixed(6)} deviates ${(dev*100).toFixed(1)}% from 5-day avg $${avg.toFixed(6)}`);
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(NAV_FILE, JSON.stringify(history, null, 2));
  console.log(`[NAV Stamp] Saved ${history.length} records.`);

  // Day-over-day
  let dayChange = null;
  if (todayIdx > 0) {
    const prev = history[todayIdx - 1];
    if (prev?.SharePrice > 0) {
      dayChange = ((vaultData.sharePrice - prev.SharePrice) / prev.SharePrice) * 100;
    }
  }

  console.log(`\n=== OFFICIAL NAV — ${todayDate} (Public JLP Hedge Vault) ===`);
  console.log(`Share Price: $${record.SharePrice.toFixed(6)}`);
  console.log(`TVL:         $${record.tvl.toLocaleString()}`);
  console.log(`Source:      Drift on-chain (public vault)`);
  if (dayChange !== null) {
    console.log(`Day Change:  ${dayChange >= 0 ? '+' : ''}${dayChange.toFixed(4)}%`);
  }
}

main().catch(err => {
  console.error(`[NAV Stamp] FATAL: ${err.message}`);
  process.exit(1);
});
