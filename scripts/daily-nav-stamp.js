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
 */

const fs   = require('fs');
const path = require('path');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { Wallet } = require('@coral-xyz/anchor');
const { DriftClient } = require('@drift-labs/sdk/lib/node/index.js');
const { VaultClient, getDriftVaultProgram } = require('@drift-labs/vaults-sdk');

// ── Config ────────────────────────────────────────────────────────────────────
const PUBLIC_VAULT_ADDRESS = '2dNSa3fBPMoxcs46NhtdLeTJuLasDt6VYNG4vopa7mWw';
const RPC_URL              = 'https://mainnet.helius-rpc.com/?api-key=86b538c8-91f4-4ae5-95ec-4392a2fbecaf';
const PRIVATE_VAULT_URL    = 'https://app.primenumber.trade/data/PN_KV1.json';
const DATA_DIR             = path.join(__dirname, '..', 'data');
const NAV_FILE             = path.join(DATA_DIR, 'official-nav-history.json');
const SCRIPT_TIMEOUT_MS    = 90_000; // 90s hard kill — Drift WS can be slow

// ── Telegram ──────────────────────────────────────────────────────────────────
// Load token from env or secrets file — NEVER hardcode
function loadTelegramToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    const secretsPath = require('path').join(process.env.HOME, '.openclaw/secrets.env');
    const lines = require('fs').readFileSync(secretsPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^(?:export\s+)?TELEGRAM_BOT_TOKEN=["']?([^"'\s]+)["']?$/);
      if (m) return m[1].trim();
    }
  } catch {}
  return null;
}
const TELEGRAM_TOKEN  = loadTelegramToken();
const TELEGRAM_CHAT   = '6509624622';
if (!TELEGRAM_TOKEN) {
  console.error('[NAV Stamp] FATAL: TELEGRAM_BOT_TOKEN not set — cannot send alerts');
  process.exit(1);
}

async function sendTelegram(message) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text: message, parse_mode: 'Markdown' }),
    });
    const body = await res.json();
    if (!body.ok) console.warn(`[NAV Stamp] Telegram API error: ${JSON.stringify(body)}`);
  } catch (e) {
    // Last resort — log only, can't alert if network is down
    console.warn(`[NAV Stamp] Telegram send failed: ${e.message}`);
  }
}

// ── Global hard timeout ───────────────────────────────────────────────────────
// Guards against Drift WebSocket hanging indefinitely
const globalTimer = setTimeout(async () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  console.error('[NAV Stamp] TIMEOUT — script ran >90s without completing');
  await sendTelegram(
    `🚨 *KV NAV Stamp TIMED OUT* — ${today}\n\n` +
    `Script ran for 90s without finishing. Share price was NOT recorded.\n` +
    `Likely cause: Drift/Helius RPC connection hung.\n\n` +
    `Run manually: \`cd ~/clawd/Keyvault-Dashboards- && node scripts/daily-nav-stamp.js\``
  );
  process.exit(2);
}, SCRIPT_TIMEOUT_MS);
globalTimer.unref(); // Don't prevent normal exit

// ── Helpers ───────────────────────────────────────────────────────────────────
function getESTDate(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function loadHistory() {
  try {
    if (fs.existsSync(NAV_FILE)) return JSON.parse(fs.readFileSync(NAV_FILE, 'utf-8'));
  } catch (e) {
    console.warn(`[NAV Stamp] History load error: ${e.message}`);
  }
  return [];
}

// Atomic write — write to .tmp then rename to avoid corruption on crash/disk-full
function saveHistory(history) {
  const tmp = NAV_FILE + '.tmp';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
  fs.renameSync(tmp, NAV_FILE);
}

// ── Data fetchers ─────────────────────────────────────────────────────────────
async function fetchPublicVaultSharePrice() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const wallet     = new Wallet(Keypair.generate());

  const driftClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    accountSubscription: { type: 'websocket' },
  });

  await driftClient.subscribe();

  const program      = getDriftVaultProgram(connection, wallet);
  const vaultClient  = new VaultClient({ driftClient, program });
  const vaultAddress = new PublicKey(PUBLIC_VAULT_ADDRESS);

  const [equityBN, vaultAccount] = await Promise.all([
    vaultClient.calculateVaultEquityInDepositAsset({ address: vaultAddress }),
    program.account.vault.fetch(vaultAddress),
  ]);

  await driftClient.unsubscribe();

  const PRECISION    = 1_000_000;
  const equityUSDC   = equityBN.toNumber() / PRECISION;
  const totalShares  = vaultAccount.totalShares.toNumber() / PRECISION;

  // ── Guard: zero/invalid shares ────────────────────────────────────────────
  if (!totalShares || totalShares <= 0) {
    throw new Error(`Invalid totalShares: ${totalShares} — vault data may be corrupted or unavailable`);
  }

  const sharePrice   = equityUSDC / totalShares;
  const basePriceRaw = (vaultAccount.netDeposits.toNumber() / PRECISION) / totalShares;

  // ── Guard: sanity check on share price ───────────────────────────────────
  if (!isFinite(sharePrice) || isNaN(sharePrice) || sharePrice <= 0 || sharePrice > 100) {
    throw new Error(`Implausible share price: ${sharePrice} (equity: ${equityUSDC}, shares: ${totalShares})`);
  }

  console.log(`[NAV Stamp] Vault equity: $${equityUSDC.toFixed(2)}, shares: ${totalShares.toFixed(4)}`);
  console.log(`[NAV Stamp] Public vault share price: $${sharePrice.toFixed(6)} (baseline: $${basePriceRaw.toFixed(6)})`);

  return { sharePrice, basePriceRaw };
}

async function fetchPrivateVaultTVL() {
  try {
    const res = await fetch(PRIVATE_VAULT_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.tvl || !data.SharePrice) throw new Error('Missing tvl or SharePrice in response');
    console.log(`[NAV Stamp] Private vault TVL (KV1): $${Number(data.tvl).toLocaleString()}`);
    return { tvl: data.tvl, rawSharePrice: data.SharePrice };
  } catch (e) {
    console.warn(`[NAV Stamp] Private vault TVL fetch FAILED: ${e.message}`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[NAV Stamp] ${new Date().toISOString()} — Starting`);

  const [publicVault, privateVault] = await Promise.all([
    fetchPublicVaultSharePrice(),
    fetchPrivateVaultTVL(),
  ]);

  const sharePrice = publicVault.sharePrice;
  const tvl        = privateVault?.tvl ?? null;
  const now        = new Date();
  const todayDate  = getESTDate(now);

  // ── History ───────────────────────────────────────────────────────────────
  const history = loadHistory();

  const record = {
    date:         todayDate,
    timestamp:    now.toISOString(),
    SharePrice:   sharePrice,
    basePriceRaw: publicVault.basePriceRaw,
    tvl:          tvl,
    rawSharePrice: privateVault?.rawSharePrice ?? null,
    source:       'public-drift-vault-equity + private-kv1-tvl',
  };

  const existingIdx = history.findIndex(h => h.date === todayDate);
  if (existingIdx >= 0) {
    history[existingIdx] = record;
    console.log(`[NAV Stamp] Updated entry for ${todayDate}`);
  } else {
    history.push(record);
    console.log(`[NAV Stamp] Added entry for ${todayDate}`);
  }

  history.sort((a, b) => a.date.localeCompare(b.date));

  // ── Price deviation check ─────────────────────────────────────────────────
  const todayIdx = history.findIndex(h => h.date === todayDate);
  const lastFew  = history.slice(Math.max(0, todayIdx - 4), todayIdx).map(h => h.SharePrice).filter(Boolean);
  let deviationAlert = null;
  if (lastFew.length > 0) {
    const avg = lastFew.reduce((a, b) => a + b, 0) / lastFew.length;
    const dev = Math.abs(sharePrice - avg) / avg;
    if (dev > 0.05) {
      const msg = `Price deviates ${(dev * 100).toFixed(1)}% from 5-day avg ($${avg.toFixed(6)})`;
      console.warn(`[NAV Stamp] ⚠️ WARNING: ${msg}`);
      deviationAlert = msg;
    }
  }

  // ── Save (atomic) ─────────────────────────────────────────────────────────
  saveHistory(history);
  console.log(`[NAV Stamp] Saved ${history.length} records.`);

  // ── Day change ────────────────────────────────────────────────────────────
  let dayChange = null;
  if (todayIdx > 0) {
    const prev = history[todayIdx - 1];
    if (prev?.SharePrice > 0) dayChange = ((sharePrice - prev.SharePrice) / prev.SharePrice) * 100;
  }

  console.log(`\n=== NAV STAMP — ${todayDate} ===`);
  console.log(`Share Price: $${sharePrice.toFixed(6)}`);
  if (tvl) console.log(`TVL (KV1):   $${Number(tvl).toLocaleString()}`);
  if (dayChange !== null) console.log(`Day Change:  ${dayChange >= 0 ? '+' : ''}${dayChange.toFixed(4)}%`);

  // ── Telegram success alert ────────────────────────────────────────────────
  const changeStr = dayChange !== null ? `${dayChange >= 0 ? '+' : ''}${dayChange.toFixed(4)}%` : 'N/A';
  const tvlStr    = tvl ? `$${Number(tvl).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '⚠️ unavailable';

  let telegramMsg =
    `✅ *KV NAV Stamp — ${todayDate}*\n\n` +
    `Share Price: \`$${sharePrice.toFixed(6)}\`\n` +
    `KV1 TVL: \`${tvlStr}\`\n` +
    `Day Change: \`${changeStr}\``;

  if (!tvl) {
    telegramMsg += `\n\n⚠️ _Private vault TVL unavailable — Prime Number API may be down._`;
  }
  if (deviationAlert) {
    telegramMsg += `\n\n⚠️ *PRICE ALERT:* ${deviationAlert}`;
  }

  await sendTelegram(telegramMsg);

  // Force exit — Drift WebSocket keeps event loop alive after unsubscribe
  clearTimeout(globalTimer);
  process.exit(0);
}

// ── Entry point ───────────────────────────────────────────────────────────────
main().catch(async err => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  console.error(`[NAV Stamp] FATAL: ${err.message}`);
  console.error(err.stack);
  await sendTelegram(
    `🚨 *KV NAV Stamp FAILED* — ${today}\n\n` +
    `Error: ${err.message}\n\n` +
    `Share price was NOT recorded. Run manually:\n` +
    `\`cd ~/clawd/Keyvault-Dashboards- && node scripts/daily-nav-stamp.js\``
  );
  process.exit(1);
});
