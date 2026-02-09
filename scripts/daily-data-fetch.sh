#!/bin/bash
# Daily data fetch for JLP Analytics Dashboard
# Runs: Drift funding rates + JLP pool snapshot
# Commits and pushes to GitHub Pages

cd "$(dirname "$0")/.."

echo "=== Daily Data Fetch $(date) ==="

# 1. Fetch Drift funding rates
echo "Fetching Drift funding rates..."
node scripts/fetch-drift-funding.js

# 2. Fetch JLP pool snapshot (NAV, AUM, fees, trader exposure)
echo "Fetching JLP pool snapshot..."
node scripts/fetch-jlp-snapshot.js

# 3. Commit and push
git add data/
git commit -m "data: daily update $(date +%Y-%m-%d)" 2>/dev/null
git push origin main 2>/dev/null

echo "=== Done ==="
