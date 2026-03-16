# KeyVault — Trading Bot Resources

A curated list of open-source repos, tools, and reference material for KV trading bot development.

---

## 🤖 Trading Agent Frameworks

### Senpi Skills — `Senpi-ai/senpi-skills`
**What:** 22 open-source autonomous trading agents for Hyperliquid. All running with real money, full live P&L tracker at [strategies.senpi.ai](https://strategies.senpi.ai). MIT licensed.

**Why relevant:** Direct Hyperliquid integration (relevant to cross-platform JLP strategy). Real-world battle-tested results — 34.5% ROI on top strategy.

**Top strategies to study:**
| Strategy | Edge | ROI | Notes |
|----------|------|-----|-------|
| 🦊 FOX | Leaderboard breakout sniper — catches first jumps before crowd | +34.5% | #1 performer, 3min scanner |
| 🦊 VIXEN | Dual-mode: quiet accumulation (STALKER) + violent breakouts (STRIKER) | TBD | Built from FOX live data |
| 🐺 WOLF | Smart money / leaderboard momentum front-running | TBD | Pack hunter |
| 🐻 GRIZZLY | BTC only, 12-20x leverage, 3-mode lifecycle | +11.2% | Hunting→Riding→Stalking→Reload |
| 🦅 HAWK | BTC/ETH/SOL/HYPE 30-sec scanner, picks strongest signal | TBD | Fast, single-asset focus |
| 🐍 VIPER | Mean reversion at S/R — works in ranging markets | TBD | Complement to trend strategies |
| 🦉 OWL | Pure contrarian — enters against extreme crowding | TBD | Funding exhaustion signals |
| ❌ TIGER | 5 scanners, 230 assets, meta-optimizer | -58% | **Cautionary tale** — too complex |

**Key lesson from TIGER:** More scanners ≠ better performance. Conviction filtering matters more than signal volume.

**Repos:**
- Python skills: https://github.com/Senpi-ai/senpi-skills
- TypeScript agent skills: https://github.com/Senpi-ai/senpi-agent-skills
- Live tracker: https://strategies.senpi.ai

---

## 🧠 Memory / Opponent Modeling

### mem0 — `mem0ai/mem0`
**What:** Open-source memory layer for AI agents. Stores and retrieves facts via embeddings across sessions.

**Why relevant:** Give house agents persistent memory of opponent tendencies across sessions (bluff frequency, aggression, fold-to-3bet rate). Retrieve relevant history at table start. See AgentPoker roadmap Phase 3.8.

**Repo:** https://github.com/mem0ai/mem0

---

## 📊 On-Chain Data & Trust

### FairScale — `fairscalexyz`
**What:** Agent credibility scoring API. One call returns a reputation score for any Solana wallet based on on-chain behavior.

**Why relevant:** Gate KV vault access or tournament entry by agent credibility. API live at `api.fairscale.xyz`. See AgentPoker roadmap Phase 3.7.

**Docs:** https://docs.fairscale.xyz

### AgentRank — `0xIntuition/agent-rank`
**What:** Decentralized PageRank-style trust algorithm for AI agents. Graph-based — trust propagates through endorsements, task performance, staking, and interaction history.

**Why relevant:** KV vault + AgentPoker results could feed AgentRank as verifiable on-chain credentials. Sybil-resistant. See AgentPoker roadmap Phase 3.10.

**Repo:** https://github.com/0xIntuition/agent-rank

---

## 🔗 Infrastructure

### Senpi HyperClaw — `Senpi-ai/senpi-hyperclaw-railway-template`
**What:** Railway deploy template for Senpi's Hyperliquid agent infrastructure.

**Why relevant:** Quick deploy path for running Hyperliquid trading agents in production.

---

*Last updated: 2026-03-15*

---

## 🔁 Blofin Trading Bot (Rebuild Planned)

**Status:** On hold — old bot hit loss limit Feb 19 (-$3,594 simulated). Rebuilding with Senpi strategies.

**Plan:**
1. Get fresh Blofin API keys (Deven to provide)
2. Port **FOX strategy** from `Senpi-ai/senpi-skills` — leaderboard momentum sniper, +34.5% live ROI on Hyperliquid perps
3. Also test **WOLF** (smart money front-running) and **VIPER** (mean reversion)
4. Paper trade first (2-3 weeks) before real capital
5. Kick off after Prime Number cross-platform vault launches

**Keys needed:** New BLOFIN_API_KEY + BLOFIN_SECRET_KEY + BLOFIN_PASSPHRASE (current keys returning 403)

*Last updated: 2026-03-15*

---

## 📊 Market Analysis Tools

### MMT (Market Maker Tools) — Free
**What:** Professional-grade Hyperliquid order flow terminal. Went fully free March 15, 2026.

**Tools included:**
- Market Profile / TPO — price distribution (institutional-grade)
- Aggregated & HD Heatmaps — where liquidity is stacked
- Liquidation Heatmap — where stop hunts and cascades will happen
- Hyperliquid TP Heatmap — shows where take-profit orders cluster (on-chain only possible on HL)
- Hyperliquid MBO Profile, Stop Loss visualization

**Why relevant:** Signal generation for Senpi FOX/WOLF strategies. Liquidation + TP heatmaps show exactly where momentum will accelerate — key for leaderboard front-running strategies.

**Twitter:** [@MMT_Official_](https://x.com/mmt_official_)

*Last updated: 2026-03-15*
