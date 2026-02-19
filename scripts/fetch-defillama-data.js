#!/usr/bin/env node
/**
 * Fetch Jupiter Perps fee data from DefiLlama (Allium fallback).
 * Outputs:
 *   data/allium-fees.json       — Daily fee revenue (last 90 days)
 *
 * NOTE: DefiLlama does NOT provide trader P&L.
 * allium-trader-pnl.json is left untouched (stale data preserved).
 * Renew Allium subscription to restore trader P&L.
 *
 * DefiLlama fees endpoint: https://api.llama.fi/summary/fees/jupiter-perpetuals?dataType=dailyFees
 */

const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');

async function fetchJupiterFees() {
    console.log('Fetching Jupiter Perps fees from DefiLlama...');
    const resp = await fetch(
        'https://api.llama.fi/summary/fees/jupiter-perpetual-exchange?dataType=dailyFees'
    );
    if (!resp.ok) throw new Error(`DefiLlama error: ${resp.status} ${await resp.text()}`);
    const json = await resp.json();

    // DefiLlama returns { totalDataChart: [[timestamp, value], ...], ... }
    const rawData = json.totalDataChart || [];

    // Last 90 days
    const ninetyDaysAgo = Date.now() / 1000 - 90 * 86400;
    const filtered = rawData
        .filter(([ts]) => ts >= ninetyDaysAgo)
        .map(([ts, fees]) => {
            const date = new Date(ts * 1000).toISOString().split('T')[0];
            return {
                date,
                total_fees: parseFloat((fees || 0).toFixed(2)),
                position_fees: parseFloat((fees || 0).toFixed(2)), // DL doesn't split by type
                swap_fees: 0,
                close_count: null,
                total_txns: null,
                source: 'defillama',
            };
        })
        .sort((a, b) => a.date.localeCompare(b.date));

    return filtered;
}

async function main() {
    try {
        const feesData = await fetchJupiterFees();

        fs.writeFileSync(
            path.join(DATA_DIR, 'allium-fees.json'),
            JSON.stringify(feesData, null, 2)
        );
        console.log(`✅ Saved ${feesData.length} days of fee data (DefiLlama)`);
        console.log('⚠️  Trader P&L not available from DefiLlama — allium-trader-pnl.json unchanged (stale)');
        console.log('   Renew Allium subscription to restore trader P&L data.');

        // Update last-fetch metadata
        const metaPath = path.join(DATA_DIR, 'allium-meta.json');
        fs.writeFileSync(metaPath, JSON.stringify({
            lastFetch: new Date().toISOString(),
            source: 'defillama',
            feeDays: feesData.length,
            traderPnlAvailable: false,
            warning: 'Allium subscription expired. Trader P&L data is stale.'
        }, null, 2));

    } catch (e) {
        console.error('DefiLlama fetch failed:', e.message);
        process.exit(1);
    }
}

main();
