#!/usr/bin/env node
/**
 * Snapshot trader P&L and pool metrics from Jupiter's JLP API.
 * Run daily via cron. Accumulates into data/trader-pnl-snapshots.json
 */

const fs = require('fs');
const path = require('path');

const JLP_INFO_URL = 'https://perps-api.jup.ag/v2/jlp-info';
const DATA_FILE = path.join(__dirname, '..', 'data', 'trader-pnl-snapshots.json');

async function main() {
    try {
        const resp = await fetch(JLP_INFO_URL);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const info = await resp.json();

        const snapshot = {
            timestamp: new Date().toISOString(),
            date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
            // Pool metrics
            poolNavUsd: info.poolNavUsd,
            aumUsd: info.aumUsd,
            jlpPrice: info.jlpPrice,
            jlpSupply: info.jlpSupply,
            // APY/APR
            jlpApyPct: parseFloat(info.jlpApyPct),
            jlpAprPct: parseFloat(info.jlpAprPct),
            // Trader exposure (the key data we're accumulating)
            totalLongExposureUsd: info.totalLongExposureUsd,
            totalShortExposureUsd: info.totalShortExposureUsd,
            totalOpenInterestUsd: info.totalOpenInterestUsd,
            // Per-asset trader P&L if available
            traderPnl: info.traderPnl || null,
            unrealizedPnl: info.unrealizedPnl || null,
            // Raw pool info for future analysis
            poolApy24h: info.poolApy24h || null,
        };

        // Load existing data
        let data = [];
        if (fs.existsSync(DATA_FILE)) {
            data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }

        // Avoid duplicate entries for same date (keep latest)
        data = data.filter(d => d.date !== snapshot.date);
        data.push(snapshot);

        // Sort by date
        data.sort((a, b) => a.date.localeCompare(b.date));

        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        console.log(`✅ Snapshot saved for ${snapshot.date} — OI: $${(parseInt(snapshot.totalOpenInterestUsd || 0) / 1e6).toFixed(1)}M, APY: ${snapshot.jlpApyPct}%`);
    } catch (err) {
        console.error('❌ Failed to fetch trader P&L:', err.message);
        process.exit(1);
    }
}

main();
