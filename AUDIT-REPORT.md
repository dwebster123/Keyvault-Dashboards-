# KeyVault Dashboard Codebase Audit Report

**Date:** 2026-02-15  
**Auditor:** Nix (automated code review)  
**Scope:** All HTML dashboards, data files, and scripts in `Keyvault-Dashboards-/`

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 2 |
| HIGH | 8 |
| MEDIUM | 12 |
| LOW | 9 |

---

## CRITICAL

### C1. Earnings Mismatch — $213,456 Displayed vs $201,502 in Data

**Files:** `index.html` (lines ~1380-1390), `vault.html` (line ~490-495), `data/investor-flows.json`

**Issue:** Both `index.html` and `vault.html` hardcode:
```js
const PUBLIC_VAULT_EARNINGS = 211989;
const PRIVATE_VAULT_EARNINGS = 1467;
// Total = $213,456
```

But `investor-flows.json` reports:
```json
"totalEarnings": {
  "publicVault": 200035,
  "privateVault": 1467,
  "combined": 201502
}
```

The discrepancy is **$11,954** ($211,989 vs $200,035 for public vault). The HTML comments say "EVd3=$203,650 + Dq95=$8,305 + AV3=$34 = $211,989" — but `investor-flows.json` has EVd3=$200,000, AV3=$35, Dq95=$0 (with $33 in private). The wallet-level data in `investor-flows.json` doesn't match the hardcoded totals.

**Impact:** Investors see inflated earnings. This is the single most important accuracy issue.

**Fix:** Reconcile the two data sources. Either update `investor-flows.json` wallets to match the Drift-verified numbers, or update the hardcoded values to match the JSON. The dashboard should read from `investor-flows.json` dynamically rather than hardcoding.

---

### C2. Timezone Bug — `new Date("YYYY-MM-DD")` Without Timezone

**Files:** `index.html` (multiple), `vault.html` (multiple), `jlp-analytics.html` (line ~529)

**Issue:** Throughout the codebase, dates are parsed as:
```js
new Date(metrics.inceptionDate).toLocaleDateString()  // index.html
new Date(bestDay.date).toLocaleDateString()            // index.html
new Date(start2025.date).toLocaleDateString()          // index.html
```

Where `date` is a string like `"2025-02-26"`. Per the ECMAScript spec, `new Date("2025-02-26")` is parsed as **UTC midnight**, which in US Pacific/Eastern timezones displays as the **previous day** (Feb 25).

Specifically in `jlp-analytics.html` line ~529:
```js
.map(e => ({ date: new Date(e.date + 'T00:00:00Z'), ... }));
```
This correctly appends `T00:00:00Z` — but the fix is inconsistent. Most other places don't do this.

**Instances:**
- `index.html`: `new Date(metrics.inceptionDate).toLocaleDateString()` (line ~335)
- `index.html`: `new Date(bestDay.date).toLocaleDateString()` (lines ~370, 375)
- `index.html`: `new Date(start2025.date).toLocaleDateString()` (line ~362)
- `index.html`: `new Date(end2025.date).toLocaleDateString()` (line ~367)
- `index.html`: `new Date(latestCommonDate).toLocaleDateString()` (comparison metrics)
- `vault.html`: `new Date(m.updateTime)` — used in various places

**Impact:** Dates display one day off for all US-timezone users. E.g., "Inception Date: Feb 25, 2025" instead of "Feb 26, 2025".

**Fix:** Append `T12:00:00` (noon) or `T00:00:00Z` and use `timeZone: 'UTC'` in `toLocaleDateString()` options. Or parse as `new Date(dateStr + 'T17:00:00-05:00')` to match the 5 PM EST NAV stamp convention (as done correctly in `renderVaultMetrics`).

---

## HIGH

### H1. Fee Calculation Inconsistency Between index.html and vault.html

**Files:** `index.html` (line ~280), `vault.html` (line ~485)

**Issue:** `index.html` applies a flat `grossReturn * (1 - 0.30)` for net returns — a simple 30% haircut on total gross gains. This assumes the share price is fully gross (before any fees).

`vault.html` uses a more nuanced `NET_INVESTOR_FACTOR = (1 - 0.30) / (1 - 0.10) = 7/9 ≈ 0.7778` — because the vault API share price is already net of Prime's 10%.

The comment in `index.html` (line ~253) acknowledges this: "Using full 30% uniformly because spreadsheet era dominates (~316 of ~350 days)". But now with 355 entries and 39 having TVL (API-sourced), the API data is growing. The two dashboards will show **different net ROI numbers** for the same data.

**Impact:** Inconsistent numbers between public and private dashboards. The discrepancy grows as more API-sourced data accumulates.

**Fix:** Both dashboards should use the same fee logic. For API-era data (source != 'public-vault-spreadsheet'), use `NET_INVESTOR_FACTOR (7/9)`. For spreadsheet data, use `(1 - 0.30)`. Or better: standardize all share prices to one convention in `official-nav-history.json`.

---

### H2. TOTAL_SHARES Hardcoded — Stale After Withdrawals

**File:** `vault.html` (line ~351)

```js
const TOTAL_SHARES = 3937611.470579;
```

**Issue:** This was the share count at some point, but after two large withdrawals ($519K on Feb 6 and $599K on Feb 14), shares were burned. The current TVL of ~$3.34M at share price ~$1.001 implies ~3,337,000 shares. The hardcoded value is ~18% too high.

This value is used in `fetchDriftData()` to calculate share price from balance: `sharePrice = balance / TOTAL_SHARES`. If the Drift API path is ever used (fallback when official NAV is unavailable), the share price would be significantly wrong.

**Impact:** Incorrect share price calculation in fallback path. Currently mitigated because official NAV is the primary source.

**Fix:** Fetch `totalShares` dynamically from the vault API, or update the hardcoded value after each flow event.

---

### H3. vault.html Auto-Refreshes Every 60 Seconds — Pointless and Wasteful

**File:** `vault.html` (line ~1658)

```js
setInterval(fetchData, 60 * 1000);
```

**Issue:** The dashboard's primary data source is `official-nav-history.json` which updates once daily at 5 PM EST. Refreshing every 60 seconds fetches the same stale JSON file plus hits the Drift API and Prime Number API unnecessarily. Each refresh makes 5+ network requests.

**Impact:** Unnecessary API load, potential rate limiting from Drift/Prime Number APIs, no user benefit.

**Fix:** Remove auto-refresh or extend to 30+ minutes. The comment in `index.html` correctly says "No auto-refresh — data updates daily via NAV stamp system."

---

### H4. CORS Proxy Cascade — Security and Reliability Risk

**File:** `vault.html` (lines ~337-343)

```js
const CORS_PROXIES = [
    { name: 'direct', url: u => u, parse: r => r.json() },
    { name: 'keyvault-worker', url: u => `https://keyvault.deven-m-webster.workers.dev/...` },
    { name: 'allorigins-raw', ... },
    { name: 'allorigins-get', ... },
    { name: 'codetabs', ... },
    { name: 'corsproxy-io', ... },
];
```

**Issue:** Using third-party CORS proxies (allorigins, codetabs, corsproxy.io) to fetch sensitive financial data means those proxies can see and potentially modify the response. A malicious or compromised proxy could inject fake share prices.

**Impact:** Man-in-the-middle risk for financial data. Also, these free proxies are unreliable and frequently go down.

**Fix:** Use only the Cloudflare Worker (`keyvault-worker`) which you control. Or better: the daily data fetch already caches Prime Number data locally (`pn-kv1-current.json`), so the CORS proxies are only needed as a fallback. Consider removing them entirely since local data files are the primary source.

---

### H5. No Null/Undefined Guards on Critical Data Paths

**Files:** Multiple

**Issue:** Several critical code paths lack null checks:

1. `index.html` line ~237: `historicalData[historicalData.length - 1]` — if `historicalData` is empty after fetch failure, this returns `undefined` and the entire dashboard crashes.

2. `vault.html` line ~465: `const initialSharePrice = sortedHistory.length > 0 ? sortedHistory[0].SharePrice : 1` — good, but `calculatePerformanceFees` at line ~425 does `const initialPrice = history[0]?.SharePrice || 1` which could be `NaN` if `SharePrice` is `0`.

3. `jlp-analytics.html`: `feeData.forEach(...)` in `renderWaterfall()` — if `feeData` is empty (API failure), the waterfall renders "Waiting for data..." forever with no timeout or fallback.

**Impact:** Any single data fetch failure can crash the entire page with no user-visible error.

**Fix:** Add explicit empty-state checks at the top of each render function. Show a meaningful error/fallback UI when data is missing.

---

### H6. Rolling APY Calculation Bug — Periods Shorter Than Requested Show Misleading Numbers

**File:** `index.html` (lines ~295-315)

**Issue:** `calculateRollingAPYs()` in `index.html` only computes 90D, 180D, 1Y, and All Time — but the `vault.html` version computes 7D and 30D as well. More importantly, both annualize short-period returns using `(netPeriodReturn / daysAvailable) * 365`, which is extremely volatile for 7D periods and can produce absurd APY numbers (e.g., a 0.5% weekly gain annualizes to 26%).

**Impact:** Rolling APY numbers, especially 7D, can be misleading and give false impressions of performance.

**Fix:** Consider using compound annualization `((1 + return)^(365/days) - 1)` instead of linear extrapolation for shorter periods. At minimum, add a disclaimer for sub-30D periods.

---

### H7. `investor-flows.json` — Wallet Earnings Don't Sum to Totals

**File:** `data/investor-flows.json`

**Issue:** 
```
Wallets: EVd3=$200,000 + AV3=$35 + Dq95=$0 + 915V=$0 = $200,035 public
          EVd3=$1,852 + AV3=$0 + Dq95=$33 + 915V=-$418 = $1,467 private
Total listed: $200,035 public + $1,467 private = $201,502
```

But `vault.html` hardcodes `PUBLIC_VAULT_EARNINGS = 211989` (EVd3=$203,650 + Dq95=$8,305 + AV3=$34). These are completely different numbers per wallet.

**Impact:** Confusing data provenance. Which numbers are correct? The file was last updated 2026-02-15 — same day as the hardcoded values.

**Fix:** Pick one source of truth and eliminate the other. The hardcoded comments cite "Drift UI, verified 2026-02-15" — update the JSON to match, or vice versa.

---

### H8. `daily-nav-stamp.js` — No TVL Validation Against Withdrawals

**File:** `scripts/daily-nav-stamp.js` (lines ~60-65)

**Issue:** The script validates that TVL > 0 but doesn't check for sudden large drops that would indicate a data error vs a real withdrawal. The 5% deviation check (line ~92) only compares share price, not TVL. A TVL dropping from $3.9M to $3.3M (15% drop) due to a withdrawal is normal, but a TVL dropping to $0 due to an API error would silently write bad data.

**Impact:** A momentary API glitch returning tvl=0 would corrupt the NAV history.

**Fix:** Add a TVL reasonableness check: if TVL drops more than 30% from previous entry, log a warning and optionally skip the write.

---

## MEDIUM

### M1. Hardcoded Market Breakdown in jlp-analytics.html

**File:** `jlp-analytics.html` (lines ~212-225)

**Issue:** The "Market Breakdown (7D)" section is entirely hardcoded HTML:
```html
<span>SOL</span> <span>27L ($1.2M) · 12S ($599k)</span>
<span>BTC</span> <span>6L ($312k) · 28S ($516k)</span>
<span>ETH</span> <span>4L ($38k) · 9S ($744k)</span>
```

These are static numbers that never update.

**Fix:** Either remove this section, label it clearly as a snapshot from a specific date, or derive from `kv1-trade-summary.json`.

---

### M2. Hardcoded Hedge Activity Data in jlp-analytics.html

**File:** `jlp-analytics.html` (lines ~1175-1200)

**Issue:** The hedge activity chart uses inline hardcoded daily data:
```js
const dailyData = [
    {date:'2026-01-06',trades:63,volume:1200000}, ...
];
```

This data stops at `2026-02-06` and will become increasingly stale.

**Fix:** Load from `data/kv1-trade-summary.json` which has the same data and can be updated by scripts.

---

### M3. `trader-pnl-snapshots.json` — Most Fields Are Null

**File:** `data/trader-pnl-snapshots.json`

**Issue:** The `traderPnl`, `unrealizedPnl`, `totalLongExposureUsd`, `totalShortExposureUsd`, `totalOpenInterestUsd`, and `poolApy24h` fields are all `null` in every snapshot. The JLP API apparently doesn't return these fields.

**Impact:** The `fetch-trader-pnl.js` script runs daily but captures almost no useful data. The file grows but provides no analytical value.

**Fix:** Either fix the field mapping (check if the API schema changed), or remove this script from the daily cron and rely on the Allium-sourced `trader-pnl-onchain.json` which has real data.

---

### M4. `jlpAUM` Defaults to $1.2B — Stale Fallback

**File:** `jlp-analytics.html` (line ~305)

```js
let jlpAUM = 1200000000;
```

**Issue:** If the JLP API call fails, all yield waterfall calculations use $1.2B as the pool AUM. The actual AUM fluctuates significantly (recent snapshots show ~$1.15-1.25B). A 10% error in AUM directly affects all APY calculations.

**Fix:** Use the latest value from `jlp-snapshots.json` as a cached fallback.

---

### M5. `fetchOfficialNavHistory` in jlp-analytics.html Parses Dates as UTC

**File:** `jlp-analytics.html` (line ~529)

```js
.map(e => ({ date: new Date(e.date + 'T00:00:00Z'), ... }));
```

**Issue:** This creates dates at midnight UTC. But vault NAV stamps are at 5 PM EST (10 PM UTC). When comparing vault dates to fee/pnl dates (also at midnight UTC), dates generally align. However, the `renderHedgeEfficiency()` and waterfall functions compare vault history dates to fee dates using `toISOString().slice(0,10)`, which works — but only because both happen to use UTC midnight. If either data source changes timezone convention, the join breaks silently.

**Fix:** Normalize all date comparisons to use date strings (`YYYY-MM-DD`) rather than Date objects. Already mostly done, but inconsistent.

---

### M6. Pro Forma Comparison Data Ends Feb 3, 2026

**File:** `index.html` (lines ~260-344)

**Issue:** `primeProFormaData` ends at `2026-02-03`. As time passes, the comparison chart shows an increasingly long gap where only KeyVault actual data extends beyond the pro forma endpoint. The comparison metrics use the "latest common date" correctly, but the chart visually shows KeyVault data continuing alone, which could confuse users.

**Fix:** Add a visual annotation or note on the chart indicating when pro forma data ends. Or update the pro forma data periodically.

---

### M7. `daily-data-fetch.sh` — Step Numbering Error

**File:** `scripts/daily-data-fetch.sh` (line ~38)

```bash
echo "[4/5] Fetching Prime Number vault data..."
```

But the script header says `[1/4]`, `[2/4]`, `[3/4]`, then suddenly `[4/5]` and `[5/5]`. The first three say `/4` but there are 5 steps.

**Impact:** Cosmetic only — confusing log output.

**Fix:** Renumber to `[1/5]` through `[5/5]`.

---

### M8. `daily-data-fetch.sh` — Allium Failure Doesn't Increment Error Counter

**File:** `scripts/daily-data-fetch.sh` (line ~50)

```bash
if node scripts/fetch-allium-data.js 2>&1; then
  echo "  ✅ Allium data OK"
else
  echo "  ⚠️  Allium data FAILED (non-blocking — subscription may be expired)"
fi
```

**Issue:** Unlike other steps, Allium failure doesn't increment `$ERRORS`. This is intentional (non-blocking), but it means the commit message always says `[0 errors]` even when Allium fails, and the exit code doesn't reflect partial failure.

**Impact:** Monitoring can't detect Allium data staleness from the script's exit code.

**Fix:** Track Allium errors separately, or add a `WARNINGS` counter.

---

### M9. `fetch-jlp-snapshot.js` Uses `new Date().toISOString().slice(0, 10)` for Date Key

**File:** `scripts/fetch-jlp-snapshot.js` (line ~28)

**Issue:** The snapshot date is computed as UTC date (`new Date().toISOString().slice(0, 10)`). If the script runs at 10 PM EST (which is 3 AM UTC the next day), the snapshot gets assigned tomorrow's date. The NAV stamp uses EST date correctly (`toLocaleDateString('en-CA', { timeZone: 'America/New_York' })`), but this script doesn't.

**Impact:** JLP snapshots may be dated one day ahead of the corresponding NAV stamp, causing join mismatches in the analytics dashboard.

**Fix:** Use EST date consistently: `new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })`.

---

### M10. `fetch-trader-pnl.js` — Same UTC Date Bug

**File:** `scripts/fetch-trader-pnl.js` (line ~25)

```js
date: new Date().toISOString().slice(0, 10),
```

Same issue as M9.

---

### M11. Management Fee Calculation — Uses Share Count as Dollar Amount

**File:** `vault.html` (line ~505)

```js
const managementFeeDollars = cumulativeNetDeposits * (FEE_CONFIG.managementFeeRate / (1 - FEE_CONFIG.managementFeeRate));
```

Where `cumulativeNetDeposits = totalShares` (line ~491). The `totalShares` is ~3.9M (the number of vault shares), not a dollar amount. But it's being multiplied by the management fee rate as if it's dollars.

The comment says `// Total shares = cumulative net deposits` which is only true if shares were minted at $1.00 each (which they approximately were for the private vault). But for the public vault era, shares had different prices.

**Impact:** Management fee dollar amount is approximately correct for the current vault but conceptually wrong. With the stale `TOTAL_SHARES` value (H2), this shows ~$80K in management fees, which may be significantly off.

**Fix:** Use actual cumulative dollar deposits (from investor-flows or a separate tracking variable) instead of share count.

---

### M12. Dead Code — `_removed_fallbackData`

**File:** `index.html` (line ~250)

```js
const _removed_fallbackData = "removed"; // Was [
```

**Impact:** Harmless but messy.

**Fix:** Remove the line entirely.

---

## LOW

### L1. `stat -f` in `daily-data-fetch.sh` — macOS Only

**File:** `scripts/daily-data-fetch.sh` (lines ~55-59)

```bash
"drift": "$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S' data/drift-funding-rates.json 2>/dev/null || echo 'missing')"
```

**Issue:** `stat -f` is macOS syntax. On Linux, the equivalent is `stat -c '%y'`. If the cron runs on a Linux server, all file timestamps in `fetch-status.json` will show `'missing'`.

**Fix:** Use a portable alternative like `date -r file` or detect the OS.

---

### L2. No Cache Busting on CDN Scripts

**File:** `index.html` (lines ~5-6)

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns"></script>
```

**Issue:** No version pinning. A breaking Chart.js update could break all charts.

**Fix:** Pin versions: `chart.js@4.4.0` (or whatever's currently used).

---

### L3. `jlp-analytics.html` — `arguments.callee` Usage

**File:** `jlp-analytics.html` (last lines)

```js
setInterval(arguments.callee, 5 * 60 * 1000);
```

**Issue:** `arguments.callee` is deprecated and throws in strict mode. Currently works because the code isn't in strict mode, but it's a maintenance hazard.

**Fix:** Use a named function instead.

---

### L4. `jlp-analytics.html` — `renderPriceChart` is a No-Op

**File:** `jlp-analytics.html` (line ~571)

```js
function renderPriceChart() {}
```

**Issue:** Dead function. Was likely a JLP price chart that was removed, but the function is still called in `loadAll()`.

**Fix:** Remove the empty function and its call.

---

### L5. `fetch-drift-vault-trades.js` — Uses Public RPC Endpoint

**File:** `scripts/fetch-drift-vault-trades.js` (line ~13)

```js
const RPC_URL = 'https://api.mainnet-beta.solana.com';
```

**Issue:** The public Solana RPC has aggressive rate limits. The script fetches 50 transactions with 200ms delays, which may still hit limits. There's a Helius RPC available per TOOLS.md.

**Fix:** Use the Helius RPC endpoint for reliability.

---

### L6. `vault.html` — Drift API Balance Divided by Stale Share Count

**File:** `vault.html` (lines ~355-358)

```js
const balance = parseFloat(userData.account?.balance || 0);
const sharePrice = balance / TOTAL_SHARES;
```

Duplicate of H2 but worth noting: `balance` from Drift API is raw balance (in USDC precision?), not clear if this needs decimals adjustment.

---

### L7. Console Warnings Visible to Users

**Files:** Multiple — `console.warn()` and `console.error()` throughout

**Issue:** Numerous console warnings are visible in browser DevTools. While not user-facing, sophisticated investors checking the console might see "Drift API failed", "No investor flows data", etc., which could cause unnecessary concern.

**Fix:** Prefix internal warnings with `[KV Debug]` to distinguish from errors.

---

### L8. `index.html` — `fetchStatusBanner` Updated Every 5 Minutes

**File:** `index.html` (last lines)

The banner fetches `official-nav-history.json` every 5 minutes just to display the timestamp. This is the same file already fetched on page load.

**Fix:** Read the timestamp from the already-loaded `historicalData` array instead of re-fetching.

---

### L9. `calculator.html` — No Data Source Connection

**File:** `calculator.html`

**Issue:** The calculator operates entirely on user input with no connection to actual fund performance. The default "Moderate" scenario is 16% net, but the actual all-time APY may differ significantly. There's no "Use Actual Performance" button.

**Fix:** Optionally pre-populate the return slider with the fund's actual historical APY by fetching from `official-nav-history.json`.

---

## Data Accuracy Deep Dive

### Normalization Ratio (1.1909)

The ratio is applied correctly in `daily-nav-stamp.js`: raw API price × 1.1909 = normalized price. Historical spreadsheet data doesn't need normalization (already at the correct scale). The last spreadsheet entry was ~$1.19 and the first API entry after normalization is also ~$1.19, confirming continuity.

### Rolling APY Methodology

All dashboards use linear annualization: `(periodReturn / days) * 365`. This is standard for fund reporting but understates returns in a compounding context. The methodology is consistent across all files, which is good.

### Fee Deduction Logic

- **index.html**: `netReturn = grossReturn * 0.70` — treats share price as fully gross
- **vault.html**: `netReturn = sharePriceReturn * (0.70 / 0.90)` — adjusts for Prime's pre-deducted 10%
- **jlp-analytics.html**: Uses both approaches depending on context (waterfall uses vault.html style)

The inconsistency (H1) means the public and private dashboards may show slightly different ROI/APY numbers.

### Withdrawal Impact

Withdrawals are well-documented in `investor-flows.json` with share price impact and cost estimates. The vault.html Flow-Adjusted NAV chart properly shows what performance would look like without flows. Share price (the primary metric) is correctly unaffected by withdrawals since shares are proportionally burned.

---

## Recommendations (Priority Order)

1. **Reconcile earnings data** (C1) — Most urgent. Investors may question the discrepancy.
2. **Fix timezone bugs** (C2) — Apply consistently across all files.
3. **Unify fee calculation logic** (H1) — Pick one approach, document it, use everywhere.
4. **Remove/update hardcoded values** (H2, M1, M2) — Automate what you can.
5. **Add error boundaries** (H5) — Each render function should gracefully handle missing data.
6. **Fix script date handling** (M9, M10) — Use EST dates consistently.
7. **Remove auto-refresh from vault.html** (H3) — No benefit, just API waste.
8. **Eliminate CORS proxy cascade** (H4) — Use only your own Worker or local cached data.
