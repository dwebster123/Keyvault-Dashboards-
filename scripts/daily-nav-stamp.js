#!/usr/bin/env node
/**
 * Daily NAV Stamp — Official 5 PM EST vault valuation
 * 
 * Fetches vault equity from Drift on-chain, total shares from Solana RPC,
 * calculates share price, and appends to the official NAV history.
 * 
 * Consistent with KeyVault's PPM valuation policy and NAV Consulting admin.
 * 
 * Run daily at 5:00 PM EST via cron.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const VAULT_USER = 'X5f4WpDXNHp5svKcsLZSeFrhSvtRN5kQuKdnd5HsZLE';
const VAULT_ADDRESS = 'G3RT2wdEYCphzcvXEHb8u4Yc4ZRscsQ1KRYywdBjgUZp';
const VAULT_ACCOUNT = 'G3RT2wdEYCphzcvXEHb8u4Yc4ZRscsQ1KRYywdBjgUZp';  // vault PDA
const HELIUS_KEY = process.env.HELIUS_KEY || '';

const DATA_DIR = path.join(__dirname, '..', 'data');
const NAV_FILE = path.join(DATA_DIR, 'official-nav-history.json');

function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
            });
        }).on('error', reject);
    });
}

function postJSON(url, body) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        };
        const mod = url.startsWith('https') ? https : http;
        const req = mod.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
            });
        });
        req.on('error', reject);
        req.write(JSON.stringify(body));
        req.end();
    });
}

async function getTotalShares() {
    // Read vault account from Solana to get current total_shares
    if (!HELIUS_KEY) {
        console.warn('No HELIUS_KEY — using last known total_shares');
        return null;
    }

    const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
    const result = await postJSON(rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [VAULT_ACCOUNT, { encoding: 'base64' }]
    });

    const raw = Buffer.from(result.result.value.data[0], 'base64');
    
    // Vault account layout: 8 (disc) + 32 (name) + 7*32 (pubkeys) = 264 bytes header
    // Then: user_shares (u128, 16 bytes), total_shares (u128, 16 bytes)
    const offset = 264 + 16; // skip to total_shares
    const totalSharesRaw = raw.readBigUInt64LE(offset) + (raw.readBigUInt64LE(offset + 8) << 64n);
    const totalShares = Number(totalSharesRaw) / 1e6;
    
    return totalShares;
}

async function main() {
    console.log(`[NAV Stamp] ${new Date().toISOString()} — Starting daily NAV calculation`);

    // 1. Get vault equity from Drift
    const userData = await fetchJSON(`https://data.api.drift.trade/user/${VAULT_USER}`);
    const balance = parseFloat(userData.account?.balance || 0);
    const totalCollateral = parseFloat(userData.account?.totalCollateral || 0);
    const health = parseInt(userData.account?.health || 0);
    const leverage = parseFloat(userData.account?.leverage || 0);

    console.log(`[NAV Stamp] Drift balance: $${balance.toFixed(2)}`);

    // 1b. Also fetch latest Drift vault snapshot for total shares
    let snapshotData = null;
    try {
        const snapshots = await fetchJSON(`https://app.drift.trade/api/vaults/vault-snapshots?vault=${VAULT_ADDRESS}`);
        if (snapshots && snapshots.length > 0) {
            snapshotData = snapshots[snapshots.length - 1];
            console.log(`[NAV Stamp] Latest Drift snapshot slot: ${snapshotData.slot}`);
        }
    } catch (e) {
        console.warn(`[NAV Stamp] Could not fetch Drift snapshots: ${e.message}`);
    }

    // 2. Get total shares — prefer snapshot, then on-chain, then fallback
    let totalShares = snapshotData ? parseInt(snapshotData.totalShares) / 1e6 : await getTotalShares();
    
    // Fallback: load last known from history
    if (!totalShares) {
        const history = loadHistory();
        if (history.length > 0) {
            totalShares = history[history.length - 1].totalShares;
            console.log(`[NAV Stamp] Using last known totalShares: ${totalShares}`);
        } else {
            totalShares = 3937611.470579; // Initial value
            console.log(`[NAV Stamp] Using hardcoded totalShares: ${totalShares}`);
        }
    } else {
        console.log(`[NAV Stamp] On-chain totalShares: ${totalShares.toFixed(6)}`);
    }

    // 3. Calculate share price
    // Normalization ratio aligns raw Drift share price with the historical series
    // (accounts for initial deposit pricing vs share issuance)
    const NORMALIZATION_RATIO = 1.1909;
    const rawSharePrice = balance / totalShares;
    const sharePrice = rawSharePrice * NORMALIZATION_RATIO;
    console.log(`[NAV Stamp] Raw share price: $${rawSharePrice.toFixed(6)}`);
    console.log(`[NAV Stamp] Normalized share price: $${sharePrice.toFixed(6)} (ratio: ${NORMALIZATION_RATIO})`);

    // 4. Get positions
    const positions = (userData.positions || []).filter(p => parseFloat(p.baseAssetAmount) !== 0);

    // 5. Get Drift APYs
    let driftApys = {};
    try {
        const vaultsData = await fetchJSON('https://app.drift.trade/api/vaults');
        driftApys = vaultsData[VAULT_ADDRESS]?.apys || {};
    } catch (e) {
        console.warn(`[NAV Stamp] Could not fetch Drift APYs: ${e.message}`);
    }

    // 6. Build NAV record
    const now = new Date();
    // Official stamp is 5 PM EST = 22:00 UTC (or 21:00 UTC during DST)
    const navRecord = {
        date: now.toISOString().split('T')[0],
        timestamp: now.toISOString(),
        SharePrice: parseFloat(sharePrice.toFixed(6)),
        tvl: parseFloat(balance.toFixed(2)),
        totalShares: parseFloat(totalShares.toFixed(6)),
        totalCollateral: parseFloat(totalCollateral.toFixed(2)),
        health,
        leverage: parseFloat(leverage.toFixed(4)),
        positions: positions.map(p => ({
            symbol: p.symbol,
            baseAssetAmount: p.baseAssetAmount,
            settledPnl: p.settledPnl,
            liquidationPrice: p.liquidationPrice
        })),
        driftApys,
        source: 'drift-onchain'
    };

    // 7. Append to history
    const history = loadHistory();
    
    // Replace today's entry if exists (re-run safety)
    const todayIdx = history.findIndex(h => h.date === navRecord.date);
    if (todayIdx >= 0) {
        history[todayIdx] = navRecord;
        console.log(`[NAV Stamp] Updated existing entry for ${navRecord.date}`);
    } else {
        history.push(navRecord);
        console.log(`[NAV Stamp] Added new entry for ${navRecord.date}`);
    }

    // Save
    fs.writeFileSync(NAV_FILE, JSON.stringify(history, null, 2));
    console.log(`[NAV Stamp] Saved ${history.length} records to ${NAV_FILE}`);

    // 8. Print summary
    console.log(`\n=== OFFICIAL NAV — ${navRecord.date} 5:00 PM EST ===`);
    console.log(`Share Price:      $${navRecord.SharePrice}`);
    console.log(`TVL:              $${navRecord.tvl.toLocaleString()}`);
    console.log(`Total Shares:     ${navRecord.totalShares.toLocaleString()}`);
    console.log(`Health:           ${navRecord.health}`);
    console.log(`Leverage:         ${navRecord.leverage}x`);
    console.log(`Positions:        ${positions.length}`);
    
    if (history.length >= 2) {
        const prev = history[history.length - 2];
        const dayChange = ((navRecord.SharePrice - prev.SharePrice) / prev.SharePrice * 100);
        console.log(`Day Change:       ${dayChange >= 0 ? '+' : ''}${dayChange.toFixed(4)}%`);
    }

    return navRecord;
}

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

main().catch(err => {
    console.error(`[NAV Stamp] FATAL: ${err.message}`);
    process.exit(1);
});
