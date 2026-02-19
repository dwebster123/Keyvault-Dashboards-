#!/usr/bin/env node
// Fetch Drift funding rate data from the live API
// Uses: https://mainnet-beta.api.drift.trade/fundingRates?marketIndex=N
// Outputs: ../data/drift-funding-rates.json

const fs = require('fs');
const path = require('path');

// marketIndex mapping on Drift
const MARKETS = [
  { name: 'SOL-PERP', index: 0 },
  { name: 'BTC-PERP', index: 1 },
  { name: 'ETH-PERP', index: 2 },
];

const API_BASE = 'https://data.api.drift.trade';
const OUTPUT = path.join(__dirname, '..', 'data', 'drift-funding-rates.json');

// Drift funding rate formula: fundingRate / oraclePriceTwap = hourly rate (decimal)
// Annualized % = hourlyRate * 24 * 365 * 100

async function fetchFundingRates(marketIndex) {
  const url = `${API_BASE}/fundingRates?marketIndex=${marketIndex}`;
  console.log(`Fetching marketIndex=${marketIndex}...`);
  const res = await fetch(url);
  const text = await res.text();
  
  // Response is a raw JSON array (sometimes without wrapping brackets)
  // Parse the records
  let records;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      records = parsed;
    } else if (parsed.fundingRates) {
      records = parsed.fundingRates;
    } else {
      records = [parsed];
    }
  } catch (e) {
    console.error(`Failed to parse response for marketIndex=${marketIndex}:`, e.message);
    return [];
  }
  
  console.log(`  Got ${records.length} records`);
  return records;
}

function processRecords(records) {
  // Group by date, compute daily average funding rate
  const dailyMap = {};
  
  for (const r of records) {
    const ts = parseInt(r.ts) * 1000; // Unix seconds to ms
    const date = new Date(ts).toISOString().slice(0, 10);
    const oracle = parseInt(r.oraclePriceTwap);
    if (!oracle) continue; // skip bad records
    // fundingRate is FUNDING_RATE_PRECISION (1e9), oraclePriceTwap is PRICE_PRECISION (1e6)
    const hourlyRate = (parseInt(r.fundingRate) / 1e9) / (oracle / 1e6); // decimal hourly rate
    
    if (!dailyMap[date]) {
      dailyMap[date] = { sum: 0, count: 0 };
    }
    dailyMap[date].sum += hourlyRate;
    dailyMap[date].count++;
  }
  
  // Convert to array sorted by date
  return Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { sum, count }]) => {
      const avgRate = sum / count;
      // Each record is ~1 hour, so annualized = avgRate * 24 * 365 * 100
      const annualizedPct = avgRate * 24 * 365 * 100;
      return {
        date,
        avgRate: parseFloat(avgRate.toFixed(8)),
        annualizedPct: parseFloat(annualizedPct.toFixed(4)),
      };
    });
}

async function main() {
  const result = { lastUpdated: new Date().toISOString(), markets: {} };
  
  for (const { name, index } of MARKETS) {
    const records = await fetchFundingRates(index);
    if (records.length === 0) {
      console.log(`  No data for ${name}`);
      result.markets[name] = [];
      continue;
    }
    
    const daily = processRecords(records);
    // Keep last 90 days
    result.markets[name] = daily.slice(-90);
    
    const first = daily[daily.length - 1]?.date || 'N/A';
    const last = daily[0]?.date || 'N/A';
    console.log(`  ${name}: ${daily.length} days total, keeping last ${result.markets[name].length} (${result.markets[name][0]?.date} to ${first})`);
  }
  
  // Merge with existing historical data if available
  if (fs.existsSync(OUTPUT)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
      for (const { name } of MARKETS) {
        if (existing.markets?.[name]?.length) {
          const oldByDate = {};
          for (const d of existing.markets[name]) oldByDate[d.date] = d;
          for (const d of result.markets[name]) oldByDate[d.date] = d; // new overwrites old
          result.markets[name] = Object.values(oldByDate).sort((a, b) => a.date.localeCompare(b.date));
          console.log(`  ${name}: merged to ${result.markets[name].length} days (${result.markets[name][0]?.date} to ${result.markets[name].at(-1)?.date})`);
        }
      }
    } catch (e) {
      console.log('Could not merge with existing data:', e.message);
    }
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
  console.log(`\nWritten to ${OUTPUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
