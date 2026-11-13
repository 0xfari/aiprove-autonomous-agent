// aiprove-autonomous-agent — a fully autonomous agent for the AIProve arena.
// No human in the loop: it reads aiprove.fun/skill.md, signs in with its own
// keypair, lists open bounties, and enters + completes as many as it can on
// its own, using live public market data for every forecast it makes.
//
// Usage:
//   node agent.mjs [--live]
//   API_BASE_URL=https://aiprove.fun   (default; set a staging host to run there)
//   AGENT_PRIVATE_KEY=0x...            (optional; otherwise a keypair is
//                                        generated and saved 0600 to agent-key.json)
//
// Default mode is DRY-RUN: the agent computes every prediction and logs the
// exact submission it WOULD send, but does not POST it. Pass --live to
// actually enter + submit. The agent never prints its private key or token.
//
// Forecast method (stated, reproducible, no black box):
//  - Direction calls (BTC/ETH, 24h and 7d): 24h momentum continuation.
//    Binance 24h ticker (fallback CoinGecko): if the 24h change is negative
//    the asset is more likely to close lower, so answer "no" (won't close
//    higher); confidence 0.55 + min(0.25, |change%| / 20). Mirrors the
//    momentum-continuation rule, not a coin flip.
//  - Close calls (SPY, GLD, NVDA): last close from Yahoo Finance (public, no key) plus a
//    damped drift — half of the last session's percentage move, applied to
//    the last close. A prediction, not a copy of today's price.
//  - ETH 24h PnL signal: "short" when ETH's 24h change is negative, else "long".
//  - top5-pons-24h: GeckoTerminal new pools on Robinhood Chain, Uniswap v4
//    (the Pons V2 graduation venue), ranked by fully-diluted valuation;
//    the top five tickers. Same source the pons leaderboard itself reflects.
//  - Everything else (code tasks, PosterJudge content/design, backtests,
//    referrals, X posts): skipped with a stated reason. The agent does not
//    fake work it cannot do and never posts on X as its operator.
import { Wallet } from "ethers";
import fs from "fs";

const API = (process.env.API_BASE_URL || "https://aiprove.fun").replace(/\/$/, "");
const LIVE = process.argv.includes("--live");
const KEY_PATH = "./agent-key.json";
const log = (...a) => console.log(new Date().toISOString(), ...a);

const jget = async (url) => {
  const r = await fetch(url, { headers: { "user-agent": "aiprove-autonomous-agent/1.0" } });
  if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
  return r.json();
};

function loadOrCreateKeypair() {
  if (process.env.AGENT_PRIVATE_KEY) return new Wallet(process.env.AGENT_PRIVATE_KEY);
  if (fs.existsSync(KEY_PATH)) {
    const { privateKey } = JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
    return new Wallet(privateKey);
  }
  const w = Wallet.createRandom();
  fs.writeFileSync(KEY_PATH, JSON.stringify({ address: w.address, privateKey: w.privateKey }, null, 2), { mode: 0o600 });
  log("[keypair] generated fresh keypair, address", w.address, "(saved 0600, never printed)");
  return w;
}

// --- market data (public, no keys) -----------------------------------------
async function binance24h(symbol) {
  try {
    const d = await jget(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
    return { price: parseFloat(d.lastPrice), changePct: parseFloat(d.priceChangePercent) };
  } catch { /* fall through to CoinGecko */ }
  const id = { BTCUSDT: "bitcoin", ETHUSDT: "ethereum" }[symbol];
  const d = await jget(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`);
  return { price: d[id].usd, changePct: d[id].usd_24h_change };
}

async function yahooClose(symbol) {
  // symbol like "SPY" — last two daily closes from Yahoo Finance (public, no key).
  const d = await jget(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`);
  const closes = (d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter((c) => c != null);
  if (closes.length < 2) throw new Error(`Yahoo ${symbol}: not enough closes`);
  const close = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  return { close, driftPct: ((close - prevClose) / prevClose) * 100 };
}

async function topPonsTokens() {
  // Pages 1-3 of GeckoTerminal new pools (recent ~1h of graduations), Uniswap
  // v4 only (the Pons V2 graduation venue), deduped per token by max FDV,
  // unicode-spoof names excluded.
  const best = {};
  for (let page = 1; page <= 3; page++) {
    const d = await jget(`https://api.geckoterminal.com/api/v2/networks/robinhood/new_pools?page=${page}`);
    for (const p of d.data || []) {
      if (p.relationships?.dex?.data?.id !== "uniswap-v4-robinhood") continue;
      const name = p.attributes.name.split(" / ")[0];
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/.test(name)) continue;
      const fdv = parseFloat(p.attributes.fdv_usd || 0);
      if (!best[name] || fdv > best[name]) best[name] = fdv;
    }
  }
  return Object.entries(best).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
}

// --- forecast builders ------------------------------------------------------
const direction = (changePct) => ({
  answer: changePct < 0 ? "no" : "yes",
  confidence: Math.round((0.55 + Math.min(0.25, Math.abs(changePct) / 20)) * 100) / 100,
});
const closeCall = ({ close, driftPct }, round) => {
  const v = close * (1 + (driftPct / 100) * 0.5);
  return { answer: Math.round(v / round) * round };
};

const SOLVERS = {
  "btc-tomorrow": async () => direction((await binance24h("BTCUSDT")).changePct),
  "forecast-eth-24h": async () => direction((await binance24h("ETHUSDT")).changePct),
  "forecast-btc-7d": async () => direction((await binance24h("BTCUSDT")).changePct),
  "signal-eth-pnl-24h": async () => ({ answer: (await binance24h("ETHUSDT")).changePct < 0 ? "short" : "long" }),
  "spy-close-1dollar": async () => closeCall(await yahooClose("SPY"), 1),
  "forecast-gold-tomorrow": async () => closeCall(await yahooClose("GLD"), 0.5),
  "forecast-nvda-3d": async () => closeCall(await yahooClose("NVDA"), 1),
  "top5-pons-24h": async () => ({ answer: await topPonsTokens() }),
};

async function main() {
  log(`[mode] ${LIVE ? "LIVE — submissions will be posted" : "DRY-RUN — predictions computed, nothing posted"}`);
  log("[step 1] reading skill.md from", API + "/skill.md");
  const skill = await (await fetch(`${API}/skill.md`)).text();
  if (!skill.includes("/api/auth/challenge")) throw new Error("skill.md lacks the auth flow");
  log(`[step 1] skill.md read (${skill.length} chars)`);

  const wallet = loadOrCreateKeypair();
  log("[step 2] auth challenge for", wallet.address);
  const ch = await (await fetch(`${API}/api/auth/challenge?address=${wallet.address}`)).json();
  if (!ch.challenge) throw new Error("no challenge");
  const signature = await wallet.signMessage(ch.challenge);
  const v = await (await fetch(`${API}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: wallet.address, signature }),
  })).json();
  if (!v.token) throw new Error("auth failed");
  log("[step 2] authenticated (token received, not printed)");
  const auth = { Authorization: "Bearer " + v.token };

  log("[step 3] listing open bounties");
  const list = await (await fetch(`${API}/api/bounties?status=open`)).json();
  const bounties = Array.isArray(list) ? list : list.bounties || [];
  log(`[step 3] ${bounties.length} open bounties`);

  let entered = 0, submitted = 0, skipped = 0, failed = 0;
  for (const b of bounties) {
    const solve = SOLVERS[b.slug];
    if (!solve) {
      log(`[skip] ${b.slug} — no autonomous solver (needs code/judgement/X/backtest), not faked`);
      skipped++;
      continue;
    }
    try {
      const prediction = await solve();
      log(`[solve] ${b.slug} -> ${JSON.stringify(prediction)}`);
      if (LIVE) {
        const r = await fetch(`${API}/api/bounties/${b.slug}/submit`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ prediction, handle: wallet.address.slice(0, 10) }),
        });
        const t = await r.text();
        log(`[submit] ${b.slug} HTTP ${r.status} ${t.slice(0, 160)}`);
        if (r.status === 201) { submitted++; entered++; }
        else failed++;
      } else {
        log(`[dry-run] ${b.slug} — submission NOT posted (pass --live to post)`);
        submitted++;
      }
    } catch (e) {
      log(`[fail] ${b.slug} — ${e.message} (skipped, loop continues)`);
      failed++;
    }
  }
  log(`[done] loop finished: ${submitted} completed, ${skipped} skipped, ${failed} failed, mode=${LIVE ? "LIVE" : "DRY-RUN"}`);
}

main().catch((e) => { console.error("[fatal]", e.message); process.exit(1); });
