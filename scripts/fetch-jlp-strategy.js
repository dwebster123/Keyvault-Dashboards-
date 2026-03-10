#!/usr/bin/env node
/**
 * fetch-jlp-strategy.js
 * Fetches the Prime Number JLP report and extracts the
 * "3x JLP (borrow SOL) + Mixed Funding" row.
 * Saves to data/jlp-strategy-latest.json
 */

const fs   = require('fs');
const path = require('path');

const REPORT_URL   = 'https://app.primenumber.trade/data/jlp_report.html';
const OUT_PATH     = path.join(__dirname, '..', 'data', 'jlp-strategy-latest.json');
const STRATEGY_KEY = '3x JLP (borrow SOL) + Mixed Funding';

async function fetchReport() {
    const res = await fetch(REPORT_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

function parseStrategy(html, strategyName) {
    // Strip HTML tags to get plain text, then find the row
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    const idx = text.indexOf(strategyName);
    if (idx === -1) throw new Error(`Strategy "${strategyName}" not found in report`);

    // After the strategy name, the next tokens are: startDate endDate +X.XX% +Y.YY%
    const after = text.slice(idx + strategyName.length).trim();
    const tokens = after.split(/\s+/).filter(Boolean);

    // tokens[0] = startDate (YYYY-MM-DD)
    // tokens[1] = endDate   (YYYY-MM-DD)
    // tokens[2] = cumulative return e.g. +11.34%
    // tokens[3] = annualized return  e.g. +33.37%

    const startDate    = tokens[0];
    const endDate      = tokens[1];
    const cumulRaw     = tokens[2]; // "+11.34%"
    const annualRaw    = tokens[3]; // "+33.37%"

    const cumulative   = parseFloat(cumulRaw.replace('%', ''));
    const annualized   = parseFloat(annualRaw.replace('%', ''));

    if (isNaN(cumulative) || isNaN(annualized)) {
        throw new Error(`Failed to parse returns from tokens: ${tokens.slice(0, 6).join(', ')}`);
    }

    return { strategy: strategyName, startDate, endDate, cumulative, annualized };
}

async function main() {
    console.log(`[jlp-strategy] Fetching ${REPORT_URL} …`);
    const html = await fetchReport();
    const result = parseStrategy(html, STRATEGY_KEY);

    const out = {
        ...result,
        fetchedAt: new Date().toISOString(),
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
    console.log(`[jlp-strategy] ✅ Saved → ${OUT_PATH}`);
    console.log(`[jlp-strategy]    ${result.strategy}`);
    console.log(`[jlp-strategy]    ${result.startDate} → ${result.endDate}`);
    console.log(`[jlp-strategy]    Cumulative: +${result.cumulative}%  |  Annualized: +${result.annualized}%`);
}

main().catch(e => {
    console.error(`[jlp-strategy] ❌ ${e.message}`);
    process.exit(1);
});
