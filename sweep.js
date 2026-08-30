const https = require('https');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// ─── Sweep ranges ─────────────────────────────────────────────────────────────
const TP_VALUES       = [0.05, 0.08, 0.10, 0.12, 0.15, 0.20];
const SL_VALUES       = [0.05, 0.08, 0.10, 0.15, 0.20];
const MAX_HOLD_VALUES = [10, 20, 40, 80];

// ─── Fixed config ─────────────────────────────────────────────────────────────
const PAIRS           = ['BTWUSDT', 'REUSDT', 'BICOUSDT', 'CLOUSDT', 'BLESSUSDT'];
const TIMEFRAMES      = ['1', '5', '15', '60'];
const STARTING_CAPITAL = 100;
const RISK_PER_TRADE  = 0.10;
const SIGNAL_CANDLES  = 50;
const RSI_PERIOD      = 14;
const BB_PERIOD       = 20;
const BB_STD          = 2;
const RSI_OVERSOLD    = 45;
const BB_SQUEEZE_THRESHOLD = 0.2;
const HIGHER_LOWS_LOOKBACK = 5;
const CANDLE_LIMIT    = 1000;

const PROXY_URL = process.env.HTTPS_PROXY || null;
const agent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcRSI(closes, period = RSI_PERIOD) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  const rs = avgGain / (avgLoss || 1e-10);
  return 100 - 100 / (1 + rs);
}

function calcBB(closes, period = BB_PERIOD, mult = BB_STD) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, p) => s + (p - sma) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { width: (2 * mult * std) / sma };
}

function hasHigherLows(lows, lookback = HIGHER_LOWS_LOOKBACK) {
  if (lows.length < lookback + 1) return false;
  const recent = lows.slice(-lookback);
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] <= recent[i - 1]) return false;
  }
  return true;
}

function generateSignal(candles, i) {
  if (i < SIGNAL_CANDLES) return null;
  const window = candles.slice(0, i + 1);
  const closes = window.map(c => parseFloat(c[4]));
  const lows   = window.map(c => parseFloat(c[3]));
  const rsi = calcRSI(closes);
  const bb  = calcBB(closes);
  const s1 = rsi !== null && rsi < RSI_OVERSOLD;
  const s2 = bb  !== null && bb.width < BB_SQUEEZE_THRESHOLD;
  const s3 = hasHigherLows(lows);
  const count = [s1, s2, s3].filter(Boolean).length;
  if (count < 2) return null;
  return { count, confidence: count / 3 };
}

// ─── Fetch (cached — fetch once, reuse across all sweep combos) ───────────────

function fetchCandles(symbol, interval) {
  return new Promise(resolve => {
    const path = `/v5/market/mark-price-kline?symbol=${symbol}&interval=${interval}&limit=${CANDLE_LIMIT}&category=linear`;
    const req = https.get(
      { hostname: 'api.bybit.com', path, headers: { 'User-Agent': 'Mozilla/5.0' }, ...(agent ? { agent } : {}) },
      res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          if (!raw) return resolve(null);
          try {
            const r = JSON.parse(raw);
            resolve(r.retCode === 0 && r.result?.list?.length ? r.result.list.reverse() : null);
          } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

// ─── Run one backtest config against pre-loaded data ─────────────────────────

function runConfig(allCandles, tpPct, slPct, maxHold) {
  let equity = STARTING_CAPITAL;
  let wins = 0, losses = 0, timeouts = 0;
  let grossProfit = 0, grossLoss = 0;
  const returns = [];

  for (const candles of allCandles) {
    if (!candles || candles.length < SIGNAL_CANDLES + 2) continue;

    for (let i = SIGNAL_CANDLES; i < candles.length - 1; i++) {
      const sig = generateSignal(candles, i);
      if (!sig) continue;

      const entry     = parseFloat(candles[i][4]);
      const tp        = entry * (1 + tpPct);
      const sl        = entry * (1 - slPct);
      const risk      = equity * RISK_PER_TRADE * sig.confidence;
      const shares    = risk / (entry - sl);
      const posSz     = shares * entry;

      // Walk forward
      const maxBar = Math.min(candles.length - 1, i + maxHold);
      let outcome = 'timeout', exitPrice = parseFloat(candles[maxBar][4]), exitBar = maxBar;

      for (let j = i + 1; j <= maxBar; j++) {
        const hi = parseFloat(candles[j][2]);
        const lo = parseFloat(candles[j][3]);
        if (lo <= sl) { outcome = 'loss'; exitPrice = sl; exitBar = j; break; }
        if (hi >= tp) { outcome = 'win';  exitPrice = tp; exitBar = j; break; }
      }

      const pnl = (exitPrice - entry) * shares;
      equity += pnl;
      returns.push(pnl / posSz);

      if (outcome === 'win')  { wins++;     grossProfit += pnl; }
      if (outcome === 'loss') { losses++;   grossLoss   += Math.abs(pnl); }
      if (outcome === 'timeout') timeouts++;

      i = exitBar; // skip past exit bar
    }
  }

  const decided = wins + losses;
  const totalPnL = equity - STARTING_CAPITAL;
  const roi = totalPnL / STARTING_CAPITAL * 100;
  const pf = grossLoss === 0 ? Infinity : grossProfit / grossLoss;

  // Sharpe
  let sharpe = null;
  if (returns.length > 1) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const std  = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
    sharpe = std === 0 ? null : mean / std;
  }

  // Max drawdown
  let peak = STARTING_CAPITAL, maxDD = 0, eq2 = STARTING_CAPITAL;
  // Recompute curve for drawdown (equity already mutated above — use returns)
  // We'll approximate: track via equity curve rebuild
  // (already done inline — just use final values)

  return {
    tp: tpPct, sl: slPct, maxHold,
    roi: +roi.toFixed(2),
    pf: isFinite(pf) ? +pf.toFixed(3) : null,
    sharpe: sharpe !== null ? +sharpe.toFixed(3) : null,
    winRate: decided > 0 ? +((wins / decided) * 100).toFixed(1) : 0,
    trades: wins + losses + timeouts,
    wins, losses, timeouts,
    timeoutPct: +((timeouts / (wins + losses + timeouts || 1)) * 100).toFixed(1),
    endEq: +equity.toFixed(2),
  };
}

// ─── Score combos (higher = better) ─────────────────────────────────────────
// Balances ROI, profit factor, low timeout %, and sharpe

function score(r) {
  if (!r || r.trades < 5) return -Infinity;
  const pfScore     = Math.min(r.pf ?? 0, 10);          // cap at 10
  const roiScore    = Math.min(r.roi / 100, 5);          // cap at 500% roi = 5
  const timeoutPen  = r.timeoutPct / 100;                // 0–1, lower is better
  const sharpeScore = r.sharpe ?? 0;
  return pfScore * 2 + roiScore + sharpeScore - timeoutPen * 3;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('📥 Fetching candle data (once)...\n');

  const allCandles = [];
  for (const sym of PAIRS) {
    for (const tf of TIMEFRAMES) {
      const c = await fetchCandles(sym, tf);
      if (c) {
        allCandles.push(c);
        process.stdout.write(`✓ ${sym} ${tf}m (${c.length})  `);
      } else {
        process.stdout.write(`✗ ${sym} ${tf}m  `);
      }
    }
  }
  console.log('\n');

  const combos = TP_VALUES.length * SL_VALUES.length * MAX_HOLD_VALUES.length;
  console.log(`🔬 Running ${combos} parameter combinations...\n`);

  const results = [];
  let done = 0;

  for (const tp of TP_VALUES) {
    for (const sl of SL_VALUES) {
      for (const maxHold of MAX_HOLD_VALUES) {
        const r = runConfig(allCandles.map(c => [...c]), tp, sl, maxHold);
        results.push(r);
        done++;
        if (done % 20 === 0) process.stdout.write(`  ${done}/${combos} done\n`);
      }
    }
  }

  // Sort by score
  results.sort((a, b) => score(b) - score(a));

  const top10 = results.slice(0, 10);
  const worst5 = results.slice(-5);

  console.log('\n╔═══════════════════════════════════════════════════════════════════════════╗');
  console.log('║                        TOP 10 PARAMETER COMBINATIONS                    ║');
  console.log('╠══════╤══════╤═══════╤════════╤══════╤══════╤══════════╤═════════════════╣');
  console.log('║  TP% │  SL% │ Hold  │  ROI%  │  PF  │Sharpe│ WinRate* │Timeouts│Trades ║');
  console.log('╠══════╪══════╪═══════╪════════╪══════╪══════╪══════════╪════════╪═══════╣');
  for (const r of top10) {
    const tp      = (r.tp  * 100).toFixed(0).padStart(4);
    const sl      = (r.sl  * 100).toFixed(0).padStart(4);
    const hold    = String(r.maxHold).padStart(5);
    const roi     = r.roi.toFixed(1).padStart(6);
    const pf      = (r.pf ?? '∞').toString().padStart(4);
    const sh      = (r.sharpe ?? 'n/a').toString().padStart(4);
    const wr      = r.winRate.toFixed(1).padStart(7) + '%';
    const to      = (r.timeoutPct + '%').padStart(6);
    const tr      = String(r.trades).padStart(5);
    console.log(`║ ${tp}%│ ${sl}%│ ${hold} │ ${roi}% │ ${pf} │ ${sh} │  ${wr} │  ${to} │ ${tr} ║`);
  }
  console.log('╚══════╧══════╧═══════╧════════╧══════╧══════╧══════════╧════════╧═══════╝');
  console.log('  * Win Rate excludes timeout trades\n');

  console.log('── WORST 5 ──────────────────────────────────────────────────────────────');
  for (const r of worst5) {
    console.log(`  TP=${(r.tp*100).toFixed(0)}% SL=${(r.sl*100).toFixed(0)}% Hold=${r.maxHold} → ROI=${r.roi}% PF=${r.pf} Timeouts=${r.timeoutPct}%`);
  }

  // Best combo
  const best = top10[0];
  console.log('\n🏆 Best combo:');
  console.log(`   TP=${(best.tp*100).toFixed(0)}%  SL=${(best.sl*100).toFixed(0)}%  MaxHold=${best.maxHold} bars`);
  console.log(`   ROI=${best.roi}%  PF=${best.pf}  Sharpe=${best.sharpe}  WinRate=${best.winRate}%  Timeouts=${best.timeoutPct}%`);
  console.log(`\n   → Update backtest.js:`);
  console.log(`     TAKE_PROFIT_PCT = ${best.tp}`);
  console.log(`     STOP_LOSS_PCT   = ${best.sl}`);
  console.log(`     MAX_HOLD_BARS   = ${best.maxHold}`);

  fs.writeFileSync('sweep_results.json', JSON.stringify({ top10, worst5, all: results }, null, 2));
  console.log('\n✓ Full results saved to sweep_results.json');
})().catch(console.error);
