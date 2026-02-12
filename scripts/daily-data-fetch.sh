#!/bin/bash
# Daily data fetch for JLP Analytics Dashboard
# Runs: Drift funding rates + JLP pool snapshot + Allium on-chain data
# Commits and pushes to GitHub Pages
# Each fetch runs independently — one failure won't block the rest

set -o pipefail
cd "$(dirname "$0")/.."

ERRORS=0
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')

echo "=== Daily Data Fetch $TIMESTAMP ==="

# 1. Fetch Drift funding rates
echo ""
echo "[1/4] Fetching Drift funding rates..."
if node scripts/fetch-drift-funding.js 2>&1; then
  echo "  ✅ Drift funding rates OK"
else
  echo "  ❌ Drift funding rates FAILED"
  ERRORS=$((ERRORS + 1))
fi

# 2. Fetch JLP pool snapshot (NAV, AUM, fees, trader exposure)
echo ""
echo "[2/4] Fetching JLP pool snapshot..."
if node scripts/fetch-jlp-snapshot.js 2>&1; then
  echo "  ✅ JLP snapshot OK"
else
  echo "  ❌ JLP snapshot FAILED"
  ERRORS=$((ERRORS + 1))
fi

# 3. Fetch trader P&L snapshot
echo ""
echo "[3/4] Fetching trader P&L snapshot..."
if node scripts/fetch-trader-pnl.js 2>&1; then
  echo "  ✅ Trader P&L OK"
else
  echo "  ❌ Trader P&L FAILED"
  ERRORS=$((ERRORS + 1))
fi

# 4. Fetch Allium on-chain data (fees + trader P&L)
echo ""
echo "[4/4] Fetching Allium on-chain data..."
if node scripts/fetch-allium-data.js 2>&1; then
  echo "  ✅ Allium data OK"
else
  echo "  ⚠️  Allium data FAILED (non-blocking — subscription may be expired)"
fi

# 5. Write fetch status file (dashboards can read this)
cat > data/fetch-status.json << EOF
{
  "lastFetch": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "errors": $ERRORS,
  "sources": {
    "drift": "$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S' data/drift-funding-rates.json 2>/dev/null || echo 'missing')",
    "jlp": "$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S' data/jlp-snapshots.json 2>/dev/null || echo 'missing')",
    "traderPnl": "$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S' data/trader-pnl-snapshots.json 2>/dev/null || echo 'missing')",
    "alliumFees": "$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S' data/allium-fees.json 2>/dev/null || echo 'missing')",
    "alliumTraderPnl": "$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S' data/allium-trader-pnl.json 2>/dev/null || echo 'missing')"
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
