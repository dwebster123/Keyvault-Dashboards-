#!/usr/bin/env node
/**
 * Fetch Jupiter Perps on-chain data from Allium.
 * Outputs:
 *   data/allium-fees.json      — Daily fee revenue (last 90 days)
 *   data/allium-trader-pnl.json — Daily trader P&L (last 90 days)
 *   data/trader-pnl-onchain.json — Full historical (appends new days)
 *
 * Allium SQL via Explorer async endpoint. Values in micro-USD (÷1e6 for USD).
 * Rate limit: 1 req/sec.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(
    process.env.HOME, '.openclaw', 'skills', 'allium', 'config.json'
);
const DATA_DIR = path.join(__dirname, '..', 'data');

const JUPITER_PERPS_PROGRAM = 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu';

// --- Allium helpers ---

let config;
function loadConfig() {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

async function submitQuery(sql) {
    const resp = await fetch(
        `https://api.allium.so/api/v1/explorer/queries/${config.query_id}/run-async`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': config.api_key,
            },
            body: JSON.stringify({ parameters: { sql_query: sql } }),
        }
    );
    if (!resp.ok) throw new Error(`Allium submit failed: ${resp.status} ${await resp.text()}`);
    const data = await resp.json();
    return data.run_id;
}

async function pollResults(runId, maxWaitMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        await new Promise(r => setTimeout(r, 5000));
        const resp = await fetch(
            `https://api.allium.so/api/v1/explorer/query-runs/${runId}/results?f=json`,
            { headers: { 'X-API-KEY': config.api_key } }
        );
        if (resp.status === 200) {
            const text = await resp.text();
            if (!text || text === 'null') continue; // still running
            const json = JSON.parse(text);
            if (json && json.data) return json.data;
        }
        // 202 = still running, keep polling
    }
    throw new Error(`Query ${runId} timed out after ${maxWaitMs}ms`);
}

async function runQuery(sql) {
    const runId = await submitQuery(sql);
    console.log(`  Query submitted: ${runId}`);
    return pollResults(runId);
}

// --- Queries ---

// Daily fees from ALL fee-generating events (position opens, closes, liquidations, swaps)
const FEES_QUERY = (days) => `
SELECT
    DATE(BLOCK_TIMESTAMP) as day,
    SUM(
        COALESCE(PARSED_EVENT_DATA:data:position_fee_usd::NUMBER, 0) +
        COALESCE(PARSED_EVENT_DATA:data:price_impact_fee_usd::NUMBER, 0)
    ) / 1e6 as position_fees_usd,
    SUM(
        CASE WHEN EVENT_NAME = 'PoolSwapEvent'
        THEN COALESCE(PARSED_EVENT_DATA:data:swap_usd_amount::NUMBER, 0) *
             COALESCE(PARSED_EVENT_DATA:data:fee_bps::NUMBER, 0) / 10000 / 1e6
        ELSE 0 END
    ) as swap_fees_usd,
    COUNT(DISTINCT CASE WHEN EVENT_NAME IN ('DecreasePositionEvent','LiquidateFullPositionEvent','InstantDecreasePositionEvent')
        THEN TXN_ID END) as close_count,
    COUNT(DISTINCT TXN_ID) as total_txns
FROM solana.decoded.events
WHERE PROGRAM_ID = '${JUPITER_PERPS_PROGRAM}'
    AND BLOCK_TIMESTAMP >= DATEADD(day, -${days}, CURRENT_TIMESTAMP())
    AND EVENT_NAME IN (
        'IncreasePositionEvent','InstantIncreasePositionEvent',
        'DecreasePositionEvent','InstantDecreasePositionEvent',
        'LiquidateFullPositionEvent','PoolSwapEvent'
    )
GROUP BY DATE(BLOCK_TIMESTAMP)
ORDER BY day
`;

// Daily trader P&L using has_profit + pnl_delta from decoded events
const TRADER_PNL_QUERY = (days) => `
SELECT
    DATE(BLOCK_TIMESTAMP) as day,
    SUM(
        CASE WHEN PARSED_EVENT_DATA:data:has_profit::BOOLEAN = TRUE
             THEN PARSED_EVENT_DATA:data:pnl_delta::NUMBER
             ELSE -PARSED_EVENT_DATA:data:pnl_delta::NUMBER
        END
    ) / 1e6 as trader_pnl,
    SUM(
        COALESCE(PARSED_EVENT_DATA:data:position_fee_usd::NUMBER, 0) +
        COALESCE(PARSED_EVENT_DATA:data:price_impact_fee_usd::NUMBER, 0)
    ) / 1e6 as fees,
    SUM(COALESCE(PARSED_EVENT_DATA:data:size_usd_delta::NUMBER, 0)) / 1e6 as volume,
    COUNT(*) as closes
FROM solana.decoded.events
WHERE PROGRAM_ID = '${JUPITER_PERPS_PROGRAM}'
    AND BLOCK_TIMESTAMP >= DATEADD(day, -${days}, CURRENT_TIMESTAMP())
    AND EVENT_NAME IN (
        'DecreasePositionEvent','InstantDecreasePositionEvent',
        'LiquidateFullPositionEvent'
    )
GROUP BY DATE(BLOCK_TIMESTAMP)
ORDER BY day
`;

// --- Main ---

async function main() {
    loadConfig();
    console.log('Fetching Allium on-chain data for Jupiter Perps...');

    // 1. Fetch daily fees (90 days)
    console.log('\n[1/2] Fetching daily fees (90d)...');
    const feesRaw = await runQuery(FEES_QUERY(90));

    const feesData = feesRaw.map(r => ({
        date: r.day,
        total_fees: parseFloat(r.position_fees_usd || 0) + parseFloat(r.swap_fees_usd || 0),
        position_fees: parseFloat(r.position_fees_usd || 0),
        swap_fees: parseFloat(r.swap_fees_usd || 0),
        close_count: parseInt(r.close_count || 0),
        total_txns: parseInt(r.total_txns || 0),
    }));

    fs.writeFileSync(
        path.join(DATA_DIR, 'allium-fees.json'),
        JSON.stringify(feesData, null, 2)
    );
    console.log(`  Saved ${feesData.length} days of fee data`);

    // Rate limit pause
    await new Promise(r => setTimeout(r, 1500));

    // 2. Fetch trader P&L (90 days) using has_profit + pnl_delta
    console.log('\n[2/2] Fetching trader P&L (90d)...');
    const pnlRaw = await runQuery(TRADER_PNL_QUERY(90));

    const pnlData = pnlRaw.map(r => ({
        date: r.day,
        trader_pnl: parseFloat(r.trader_pnl || 0),
        fees: parseFloat(r.fees || 0),
        volume: parseFloat(r.volume || 0),
        closes: parseInt(r.closes || 0),
    }));

    fs.writeFileSync(
        path.join(DATA_DIR, 'allium-trader-pnl.json'),
        JSON.stringify(pnlData, null, 2)
    );
    console.log(`  Saved ${pnlData.length} days of trader P&L data`);

    // 3. Update the full historical file (merge with existing)
    const fullPath = path.join(DATA_DIR, 'trader-pnl-onchain.json');
    let existing = [];
    try {
        existing = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (e) { /* fresh start */ }

    const existingMap = {};
    existing.forEach(d => { existingMap[d.date] = d; });

    // Merge: update last 90 days with fresh data, keep older data
    pnlData.forEach(d => {
        existingMap[d.date] = {
            date: d.date,
            trader_pnl: d.trader_pnl,
            fees: d.fees,
            volume: d.volume,
            closes: d.closes,
        };
    });

    // Also merge fee data into the records
    feesData.forEach(d => {
        if (existingMap[d.date]) {
            existingMap[d.date].total_fees = d.total_fees;
            existingMap[d.date].position_fees = d.position_fees;
            existingMap[d.date].swap_fees = d.swap_fees;
        } else {
            existingMap[d.date] = {
                date: d.date,
                trader_pnl: 0,
                fees: d.position_fees,
                total_fees: d.total_fees,
                position_fees: d.position_fees,
                swap_fees: d.swap_fees,
                volume: 0,
                closes: 0,
            };
        }
    });

    const merged = Object.values(existingMap).sort((a, b) => a.date.localeCompare(b.date));
    fs.writeFileSync(fullPath, JSON.stringify(merged, null, 2));
    console.log(`  Updated full history: ${merged.length} days (${existing.length} existing + new)`);

    console.log('\nDone! Files written:');
    console.log('  data/allium-fees.json');
    console.log('  data/allium-trader-pnl.json');
    console.log('  data/trader-pnl-onchain.json (updated)');
}

main().catch(e => {
    console.error('Allium error:', e.message || e);
    if (String(e).includes('401') || String(e).includes('subscription')) {
        console.error('⚠️  Allium API subscription expired or invalid. Existing data files preserved.');
        console.error('   Dashboard will show stale data with a warning.');
        process.exit(0); // Don't fail the pipeline
    }
    process.exit(1);
});
