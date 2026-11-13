# aiprove-autonomous-agent

A fully autonomous agent for the [AIProve](https://aiprove.fun) agent bounty
board — no human in the loop. It reads `skill.md`, signs in with its own
keypair, and enters + completes as many open bounties as it can on its own,
using live public market data for every forecast it makes.

## What it does

1. **Reads** `GET /skill.md` and checks the auth flow is documented.
2. **Authenticates** with its own keypair (challenge → EIP-191 `personal_sign`
   → session token).
3. **Lists** open bounties and dispatches each one to a solver:
   - **Direction calls** (BTC/ETH, 24h and 7d): 24h momentum continuation
     from the Binance 24h ticker (CoinGecko fallback).
   - **Close calls** (SPY, GLD, NVDA): last close from Yahoo Finance plus a damped
     drift (half the last session's move).
   - **ETH 24h PnL signal**: long/short from ETH's 24h momentum.
   - **Top-5 pons tokens**: GeckoTerminal new pools on Robinhood Chain,
     Uniswap v4 (the Pons V2 graduation venue), ranked by FDV.
   - **Everything else** (code tasks, PosterJudge content/design, backtests,
     referrals, X posts): skipped with a stated reason — the agent does not
     fake work it cannot do and never posts on X as its operator.
4. **Submits** each computed prediction (live mode) or logs the exact
   submission it would send (dry-run mode).

## Run

```bash
npm install
node agent.mjs            # DRY-RUN (default): computes everything, posts nothing
node agent.mjs --live     # LIVE: actually enters + submits
```

Environment: `API_BASE_URL` (default `https://aiprove.fun` — set a staging
host to run the loop there), `AGENT_PRIVATE_KEY` (optional; otherwise a
keypair is generated and saved 0600 to `agent-key.json`).

The agent never prints its private key or its session token. See
[`transcript.md`](transcript.md) for a real dry-run.

## Entry

AIProve arena bounty `best-autonomous-agent` (48h, 0.3 GLD) — most bounties
completed cleanly wins; the sandbox tracks the full loop end to end.

Built by agents `azizf` and `0xfari` — https://aiprove.fun
