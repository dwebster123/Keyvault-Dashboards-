#!/usr/bin/env node
/**
 * Daily NAV Stamp — Official 5 PM EST vault valuation
 *
 * Two data sources:
 *   - PUBLIC vault (Drift JLP Hedge Vault): real equity share price via VaultClient
 *     Address: 2dNSa3fBPMoxcs46NhtdLeTJuLasDt6VYNG4vopa7mWw
 *   - PRIVATE vault (Prime Number KV1): TVL / AUM display only
 *     API: https://app.primenumber.trade/data/PN_KV1.json
 *
 * The public vault represents the full strategy track record (382+ days).
 * Share price = vault equity (incl. unrealized P&L) / total shares — net of PM fees.
 * No PROFIT_PREMIUM fudge factor needed: DriftClient computes real equity directly.
 * The private vault is KV's actual investor capital (~$3.34M).
 */

const fs = require('fs');
const path = require('path');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { Wallet } = require('@coral-xyz/anchor');
const { DriftClient } = require('@drift-labs/sdk/lib/node/index.js');
const { VaultClient, getDriftVaultProgram } = require('@drift-labs/vaults-sdk');

// Public vault (APY / share price / graph)
const PUBLIC_VAULT_ADDRESS = '2dNSa3fBPMoxcs46NhtdLeTJuLasDt6VYNG4vopa7mWw';
// Helius WS subscription avoids batch-request restriction on free plan
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=86b538c8-91f4-4ae5-95ec-4392a2fbecaf';

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

  // Use WebSocket subscription — avoids batch-request restriction on free Helius plan
  const driftClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    accountSubscription: { type: 'websocket' },
  });

  await driftClient.subscribe();

  const program = getDriftVaultProgram(connection, wallet);
  const vaultClient = new VaultClient({ driftClient, program });
  const vaultAddress = new PublicKey(PUBLIC_VAULT_ADDRESS);

  // calculateVaultEquityInDepositAsset returns full equity (USDC, 10^6 precision)
  // including unrealized P&L from open positions — this is the real share price
  const [equityBN, vaultAccount] = await Promise.all([
    vaultClient.calculateVaultEquityInDepositAsset({ address: vaultAddress }),
    program.account.vault.fetch(vaultAddress),
  ]);

  await driftClient.unsubscribe();

  const USDC_PRECISION = 1_000_000;
  // Drift vault shares use USDC precision (10^6), not 10^9
  const SHARE_PRECISION = 1_000_000;

  const equityUSDC = equityBN.toNumber() / USDC_PRECISION;
  const totalShares = vaultAccount.totalShares.toNumber() / SHARE_PRECISION;
  const sharePrice = equityUSDC / totalShares;

  const basePriceRaw = (vaultAccount.netDeposits.toNumber() / USDC_PRECISION) / totalShares;

  console.log(`[NAV Stamp] Vault equity: $${equityUSDC.toFixed(2)}, shares: ${totalShares.toFixed(4)}`);
  return { sharePrice, basePriceRaw, profitPremium: null };
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

  console.log(`[NAV Stamp] Public vault share price: $${sharePrice.toFixed(6)} (baseline: $${publicVault.basePriceRaw.toFixed(6)})`);
  if (tvl) console.log(`[NAV Stamp] Private vault TVL (KV1): $${tvl.toLocaleString()}`);

  const now = new Date();
  const todayDate = getESTDate(now);

  const record = {
    date: todayDate,
    timestamp: now.toISOString(),
    SharePrice: sharePrice,                        // Public vault real equity — used for APY / ROI graph
    basePriceRaw: publicVault.basePriceRaw,        // Net deposits / shares (baseline, no trading P&L)
    tvl: tvl,                                      // Private vault KV1 — used for AUM display
    rawSharePrice: privateVault?.rawSharePrice ?? null,
    source: 'public-drift-vault-equity + private-kv1-tvl',
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

  // Send Telegram confirmation
  const changeStr = dayChange !== null ? `${dayChange >= 0 ? '+' : ''}${dayChange.toFixed(4)}%` : 'N/A';
  const tvlStr = tvl ? `$${Number(tvl).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : 'N/A';
  await sendTelegram(
    `✅ *KV NAV Stamp — ${todayDate}*\n\n` +
    `Share Price: \`$${sharePrice.toFixed(6)}\`\n` +
    `KV1 TVL: \`${tvlStr}\`\n` +
    `Day Change: \`${changeStr}\``
  );

  // Force exit — Drift WebSocket keeps event loop alive after unsubscribe
  process.exit(0);
}

// Telegram alert helper
async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '8533064388:AAGvDUyYXEiJZhmz0TVboTEEy9M697FyBwo';
  const chatId = '6509624622';
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
    });
  } catch (e) {
    console.warn(`[NAV Stamp] Telegram alert failed: ${e.message}`);
  }
}

main()
  .then(() => {
    // Success alert handled inside main via console — no extra needed
  })
  .catch(async err => {
    console.error(`[NAV Stamp] FATAL: ${err.message}`);
    await sendTelegram(`🚨 *KV NAV Stamp FAILED* — ${new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })}\n\nError: ${err.message}\n\nShare price was NOT recorded. Investigate immediately.`);
    process.exit(1);
  });
