#!/bin/bash
# Daily data fetch for JLP Analytics Dashboard
# Runs: Drift funding rates + JLP pool snapshot + Allium on-chain data
# Commits and pushes to GitHub Pages
# Each fetch runs independently — one failure won't block the rest

set -o pipefail
cd "$(dirname "$0")/.."

ERRORS=0
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')

# OS-portable stat for file modification time
if [[ "$(uname)" == "Darwin" ]]; then
  file_mtime() { stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S' "$1" 2>/dev/null || echo 'missing'; }
else
  file_mtime() { stat -c '%y' "$1" 2>/dev/null | cut -d. -f1 || echo 'missing'; }
fi

echo "=== Daily Data Fetch $TIMESTAMP ==="

# 1. Fetch Drift funding rates
echo ""
echo "[1/5] Fetching Drift funding rates..."
if node scripts/fetch-drift-funding.js 2>&1; then
  echo "  ✅ Drift funding rates OK"
else
  echo "  ❌ Drift funding rates FAILED"
  ERRORS=$((ERRORS + 1))
fi

# 2. Fetch JLP pool snapshot (NAV, AUM, fees, trader exposure)
echo ""
echo "[2/5] Fetching JLP pool snapshot..."
if node scripts/fetch-jlp-snapshot.js 2>&1; then
  echo "  ✅ JLP snapshot OK"
else
  echo "  ❌ JLP snapshot FAILED"
  ERRORS=$((ERRORS + 1))
fi

# 3. Fetch trader P&L snapshot
echo ""
echo "[3/5] Fetching trader P&L snapshot..."
if node scripts/fetch-trader-pnl.js 2>&1; then
  echo "  ✅ Trader P&L OK"
else
  echo "  ❌ Trader P&L FAILED"
  ERRORS=$((ERRORS + 1))
fi

# 4. Fetch Prime Number vault data (for CORS-free dashboard loading)
echo ""
echo "[4/5] Fetching Prime Number vault data (CORS-free)..."
if curl -sf "https://app.primenumber.trade/data/PN_KV1.json" -o data/pn-kv1-current.json && \
   curl -sf "https://app.primenumber.trade/data/PN_KV1_history.json" -o data/pn-kv1-history.json; then
  echo "  ✅ Prime Number data OK"
else
  echo "  ❌ Prime Number data FAILED"
  ERRORS=$((ERRORS + 1))
fi

# 5. Stamp official NAV (share price snapshot at 5 PM EST)
echo ""
echo "[5/5] Stamping official NAV..."
if node scripts/daily-nav-stamp.js 2>&1; then
  echo "  ✅ NAV stamp OK"
else
  echo "  ❌ NAV stamp FAILED"
  ERRORS=$((ERRORS + 1))
fi

# 6. Fetch on-chain fee data (DefiLlama — Allium fallback until subscription renews)
echo ""
echo "[6/6] Fetching fee data (DefiLlama fallback)..."
if node scripts/fetch-defillama-data.js 2>&1; then
  echo "  ✅ Fee data OK (DefiLlama — trader P&L unavailable until Allium renews)"
else
  echo "  ⚠️  DefiLlama fee fetch FAILED (non-blocking)"
fi

# 5. Write fetch status file (dashboards can read this)
cat > data/fetch-status.json << EOF
{
  "lastFetch": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "errors": $ERRORS,
  "sources": {
    "drift": "$(file_mtime data/drift-funding-rates.json)",
    "jlp": "$(file_mtime data/jlp-snapshots.json)",
    "traderPnl": "$(file_mtime data/trader-pnl-snapshots.json)",
    "alliumFees": "$(file_mtime data/allium-fees.json)",
    "alliumTraderPnl": "$(file_mtime data/allium-trader-pnl.json)"
  }
}
EOF

# 6. Commit and push
echo ""
git add data/
if git commit -m "data: daily update $(date +%Y-%m-%d) [${ERRORS} errors]" 2>/dev/null; then
  git push origin main 2>/dev/null && echo "✅ Pushed to GitHub" || echo "⚠️  Push failed"
else
  echo "ℹ️  No data changes to commit"
fi

echo ""
echo "=== Done ($ERRORS errors) ==="
exit $ERRORS
