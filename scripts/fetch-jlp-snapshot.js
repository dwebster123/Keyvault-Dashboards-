#!/usr/bin/env node
// Daily JLP pool snapshot - captures NAV, AUM, trader exposure
// Run daily via cron to build historical data

const fs = require('fs');
const path = require('path');

const OUTPUT = path.join(__dirname, '..', 'data', 'jlp-snapshots.json');
const JLP_API = 'https://perps-api.jup.ag/v2/jlp-info';
const DEFILLAMA_API = 'https://api.llama.fi/summary/fees/jupiter-perpetual-exchange';

async function main() {
  console.log('Fetching JLP snapshot...');
  
  const [jlpRes, feeRes] = await Promise.all([
    fetch(JLP_API),
    fetch(DEFILLAMA_API)
  ]);
  
  const jlpInfo = await jlpRes.json();
  const feeData = await feeRes.json();
  
  const aum = parseInt(jlpInfo.aumUsd) / 1e6; // to USD
  const navPrice = parseInt(jlpInfo.jlpPriceUsd) / 1e6;
  const apyPct = parseFloat(jlpInfo.jlpApyPct || 0);
  
  // Trader exposure
  const custodies = (jlpInfo.custodies || []).filter(c => ['SOL', 'ETH', 'WBTC'].includes(c.symbol));
  const traderExposure = {};
  let totalShortPnl = 0;
  
  for (const c of custodies) {
    const shortPnlDelta = parseInt(c.shortPnlDelta || 0) / 1e6;
    const hasProfit = c.shortTradersHasProfit || false;
    const actualPnl = hasProfit ? shortPnlDelta : -shortPnlDelta;
    
    traderExposure[c.symbol] = {
      guaranteedUsd: parseInt(c.guaranteedUsd || 0) / 1e6,
      globalShortSizes: parseInt(c.globalShortSizes || 0) / 1e6,
      shortPnlDelta: shortPnlDelta,
      shortTradersHasProfit: hasProfit,
      netPnl: actualPnl
    };
    totalShortPnl += actualPnl;
  }
  
  // Fee data
  const fees24h = feeData.total24h || 0;
  const chart = feeData.totalDataChart || [];
  const recent7d = chart.slice(-7);
  const avgDailyFees = recent7d.reduce((s, [, v]) => s + v, 0) / (recent7d.length || 1);
  
  const snapshot = {
    timestamp: new Date().toISOString(),
    date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    navPrice,
    aum,
    jupiterApyPct: apyPct,
    fees24h,
    avgDailyFees7d: parseFloat(avgDailyFees.toFixed(0)),
    // Real-time fee APY: (daily fees * 0.75 * 365) / AUM
    realTimeFeeApyPct: parseFloat(((avgDailyFees * 0.75 * 365) / aum * 100).toFixed(2)),
    traderExposure,
    totalTraderPnl: parseFloat(totalShortPnl.toFixed(2)),
    traderPnlLabel: totalShortPnl > 0 ? 'traders_winning' : 'pool_winning'
  };
  
  console.log(`NAV: $${navPrice.toFixed(4)}, AUM: $${(aum/1e9).toFixed(3)}B`);
  console.log(`Fees 24h: $${(fees24h/1e6).toFixed(2)}M, 7d avg: $${(avgDailyFees/1e6).toFixed(2)}M`);
  console.log(`Real-time fee APY: ${snapshot.realTimeFeeApyPct}%`);
  console.log(`Jupiter APY: ${apyPct}%`);
  console.log(`Trader PnL: $${(totalShortPnl/1e3).toFixed(0)}K (${snapshot.traderPnlLabel})`);
  
  // Load existing and append
  let history = { snapshots: [] };
  if (fs.existsSync(OUTPUT)) {
    try {
      history = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    } catch (e) {
      console.log('Could not read existing data:', e.message);
    }
  }
  
  // Deduplicate by date (keep latest per day)
  const byDate = {};
  for (const s of history.snapshots) byDate[s.date] = s;
  byDate[snapshot.date] = snapshot;
  
  history.snapshots = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  history.lastUpdated = snapshot.timestamp;
  
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(history, null, 2));
  console.log(`\nWritten to ${OUTPUT} (${history.snapshots.length} snapshots)`);
}

main().catch(e => { console.error(e); process.exit(1); });
