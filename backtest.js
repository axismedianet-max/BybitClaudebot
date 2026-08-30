const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// ─── Configuration ────────────────────────────────────────────────────────────
const PAIRS = ['BTWUSDT', 'REUSDT', 'BICOUSDT', 'CLOUSDT', 'BLESSUSDT', 'LUMIAUSDT', 'EIGENUSDT', 'BELUSDT', 'AXSUSDT', 'EDGEUSDT'];
const TIMEFRAMES = ['15', '60'];
const STARTING_CAPITAL = 100;
const RISK_PER_TRADE = 0.10;
const STOP_LOSS_PCT = 0.15;
const TAKE_PROFIT_PCT = 0.10;
const SIGNAL_CANDLES = 50;
const RSI_PERIOD = 14;
const BB_PERIOD = 20;
const BB_STD = 2;
const RSI_OVERSOLD = 45;
const BB_SQUEEZE_THRESHOLD = 0.2;
const HIGHER_LOWS_LOOKBACK = 5;
const MAX_HOLD_BARS = 20;        // close at market after this many bars if TP/SL not hit
const CANDLE_LIMIT = 1000;       // max candles per request (Bybit max)

// Proxy — set HTTPS_PROXY in .env, e.g.:
//   HTTPS_PROXY=http://user:pass@your-proxy-host:port
// Leave unset to connect directly.
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || null;
const agent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

if (PROXY_URL) {
  console.log(`🔀 Using proxy: ${PROXY_URL.replace(/:\/\/.*@/, '://***@')}\n`);
} else {
  console.log('⚠️  No proxy set (HTTPS_PROXY env var). Direct connection will be used.\n');
}

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
  return {
    upper: sma + mult * std,
    middle: sma,
    lower: sma - mult * std,
    width: (2 * mult * std) / sma,
  };
}

function hasHigherLows(lows, lookback = HIGHER_LOWS_LOOKBACK) {
  if (lows.length < lookback + 1) return false;
  const recent = lows.slice(-lookback);
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] <= recent[i - 1]) return false;
  }
  return true;
}

// ─── Signal generation ────────────────────────────────────────────────────────

function generateSignals(candles, i) {
  if (i < SIGNAL_CANDLES) return null;
  const window = candles.slice(0, i + 1);
  const closes = window.map(c => parseFloat(c[4]));
  const lows = window.map(c => parseFloat(c[3]));
  const rsi = calcRSI(closes);
  const bb = calcBB(closes);
  const higherLows = hasHigherLows(lows);
  const s1 = rsi !== null && rsi < RSI_OVERSOLD;
  const s2 = bb !== null && bb.width < BB_SQUEEZE_THRESHOLD;
  const s3 = higherLows;
  const signalCount = [s1, s2, s3].filter(Boolean).length;
  if (signalCount === 0) return null;
  return { signalCount, confidence: signalCount / 3, rsi, bbWidth: bb?.width ?? null, s1, s2, s3 };
}

// ─── Trade resolution (walk-forward) ─────────────────────────────────────────

function resolveTrade(candles, entryIndex, stopLoss, takeProfit) {
  const maxBar = Math.min(candles.length - 1, entryIndex + MAX_HOLD_BARS);

  for (let i = entryIndex + 1; i <= maxBar; i++) {
    const high = parseFloat(candles[i][2]);
    const low  = parseFloat(candles[i][3]);
    const ts   = parseInt(candles[i][0]);
    const hitSL = low  <= stopLoss;
    const hitTP = high >= takeProfit;
    // If both triggered in same candle, assume SL filled first (worst case)
    if (hitSL || hitTP) {
      return {
        outcome:   hitSL ? 'loss' : 'win',
        exitBar:   i,
        exitPrice: hitSL ? stopLoss : takeProfit,
        exitTime:  ts,
      };
    }
  }

  // Max hold time reached — close at last bar's close price
  const exitBar = maxBar;
  const exitCandle = candles[exitBar];
  return {
    outcome:   'timeout',
    exitBar,
    exitPrice: parseFloat(exitCandle[4]),
    exitTime:  parseInt(exitCandle[0]),
  };
}

// ─── Bybit fetch (with optional proxy) ───────────────────────────────────────

function fetchCandles(symbol, interval, limit = 200) {
  return new Promise((resolve, reject) => {
    const path = `/v5/market/mark-price-kline?symbol=${symbol}&interval=${interval}&limit=${limit}&category=linear`;
    const options = {
      hostname: 'api.bybit.com',
      path,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      ...(agent ? { agent } : {}),
    };

    const req = https.get(options, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (!raw) return resolve({ error: `HTTP ${res.statusCode} empty body` });
        try {
          const r = JSON.parse(raw);
          if (r.retCode === 0 && r.result?.list?.length) {
            resolve({ candles: r.result.list.reverse() });
          } else {
            resolve({ error: `retCode=${r.retCode} msg=${r.retMsg}` });
          }
        } catch (e) {
          resolve({ error: `JSON parse failed: ${e.message} — body: ${raw.slice(0, 80)}` });
        }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ error: 'timeout after 30s' }); });
  });
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function maxDrawdown(curve) {
  let peak = curve[0], maxDD = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function sharpeRatio(returns) {
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  return std === 0 ? null : mean / std;
}

function profitFactor(trades) {
  const gp = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = trades.filter(t => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0);
  return gl === 0 ? Infinity : gp / gl;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runBacktest() {
  console.log('🚀 Starting walk-forward backtest...');
  console.log(`Pairs: ${PAIRS.join(', ')}`);
  console.log(`Timeframes: ${TIMEFRAMES.map(t => t + 'm').join(', ')}`);
  console.log(`Starting capital: $${STARTING_CAPITAL}\n`);

  let equity = STARTING_CAPITAL;
  const equityCurve = [equity];
  const allTrades = [];
  const tradeReturns = [];

  for (const symbol of PAIRS) {
    for (const tf of TIMEFRAMES) {
      const result = await fetchCandles(symbol, tf, CANDLE_LIMIT);
      if (result.error) {
        console.log(`✗ ${symbol} ${tf}m — ${result.error}`);
        continue;
      }
      const { candles } = result;
      console.log(`✓ ${symbol} ${tf}m — ${candles.length} candles`);
      if (candles.length < SIGNAL_CANDLES + 2) continue;

      for (let i = SIGNAL_CANDLES; i < candles.length - 1; i++) {
        const signals = generateSignals(candles, i);
        if (!signals || signals.signalCount < 2) continue;

        const entryPrice  = parseFloat(candles[i][4]);
        const stopLoss    = entryPrice * (1 - STOP_LOSS_PCT);
        const takeProfit  = entryPrice * (1 + TAKE_PROFIT_PCT);
        const riskAmount  = equity * RISK_PER_TRADE * signals.confidence;
        const shares      = riskAmount / (entryPrice - stopLoss);
        const positionSize = shares * entryPrice;

        const resolution = resolveTrade(candles, i, stopLoss, takeProfit);
        const pnl = (resolution.exitPrice - entryPrice) * shares;
        equity += pnl;
        equityCurve.push(equity);
        tradeReturns.push(pnl / positionSize);

        allTrades.push({
          symbol, timeframe: tf + 'm',
          entryTime:  new Date(parseInt(candles[i][0])).toISOString(),
          exitTime:   new Date(resolution.exitTime).toISOString(),
          entryPrice, exitPrice: resolution.exitPrice,
          stopLoss, takeProfit,
          shares: +shares.toFixed(6),
          positionSize: +positionSize.toFixed(4),
          riskAmount: +riskAmount.toFixed(4),
          pnl: +pnl.toFixed(4),
          outcome: resolution.outcome,
          signals: {
            count: signals.signalCount,
            confidence: +(signals.confidence * 100).toFixed(0) + '%',
            rsiOversold: signals.s1, bbSqueeze: signals.s2, higherLows: signals.s3,
            rsi: signals.rsi !== null ? +signals.rsi.toFixed(2) : null,
            bbWidth: signals.bbWidth !== null ? +signals.bbWidth.toFixed(4) : null,
          },
          equityAfter: +equity.toFixed(4),
        });

        // Skip past exit bar to avoid overlapping trades on same series
        i = resolution.exitBar;
      }
    }
  }

  // ─── Report ────────────────────────────────────────────────────────────────
  const wins     = allTrades.filter(t => t.outcome === 'win').length;
  const losses   = allTrades.filter(t => t.outcome === 'loss').length;
  const timeouts = allTrades.filter(t => t.outcome === 'timeout').length;
  const total    = allTrades.length;
  const decided  = wins + losses;

  const totalPnL = equity - STARTING_CAPITAL;
  const roi = totalPnL / STARTING_CAPITAL * 100;
  const maxDD = maxDrawdown(equityCurve);
  const sharpe = sharpeRatio(tradeReturns);
  const pf = profitFactor(allTrades);
  const avgWin     = wins   > 0 ? allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins   : 0;
  const avgLoss    = losses > 0 ? allTrades.filter(t => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0) / losses : 0;
  const timeoutPnL = allTrades.filter(t => t.outcome === 'timeout').reduce((s, t) => s + t.pnl, 0);

  console.log('\n═══════════════════════════════════════════');
  console.log('             BACKTEST REPORT');
  console.log(`      (max hold: ${MAX_HOLD_BARS} bars | ${CANDLE_LIMIT} candles/series)`);
  console.log('═══════════════════════════════════════════');
  console.log(`Starting Capital:   $${STARTING_CAPITAL.toFixed(2)}`);
  console.log(`Ending Capital:     $${equity.toFixed(2)}`);
  console.log(`Total P&L:          $${totalPnL.toFixed(2)}`);
  console.log(`ROI:                ${roi.toFixed(2)}%`);
  console.log(`Max Drawdown:       ${(maxDD * 100).toFixed(2)}%`);
  console.log(`Profit Factor:      ${isFinite(pf) ? pf.toFixed(2) : '∞'}`);
  console.log(`Sharpe Ratio:       ${sharpe !== null ? sharpe.toFixed(3) : 'n/a'}`);
  console.log('───────────────────────────────────────────');
  console.log(`Total Trades:       ${total}`);
  console.log(`  Wins (TP hit):    ${wins}`);
  console.log(`  Losses (SL hit):  ${losses}`);
  console.log(`  Timeouts (${MAX_HOLD_BARS}b):  ${timeouts}  [P&L: $${timeoutPnL.toFixed(2)}]`);
  console.log(`Win Rate*:          ${decided > 0 ? (wins / decided * 100).toFixed(2) : 0}%  (*TP/SL trades only)`);
  console.log(`Avg Win:            $${avgWin.toFixed(4)}`);
  console.log(`Avg Loss:           $${avgLoss.toFixed(4)}`);
  console.log(`Reward/Risk:        ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'n/a'}`);
  console.log('═══════════════════════════════════════════\n');

  // ─── Breakdown by timeframe ────────────────────────────────────────────────
  const TF_LABELS = { '1': '1m ', '5': '5m ', '15': '15m', '60': '60m' };
  console.log('── BREAKDOWN BY TIMEFRAME ──────────────────────────────────────────────');
  console.log(' TF  │Trades│  Wins│Losses│  T/O │WinRate*│   PnL    │ AvgWin  │ AvgLoss');
  console.log('─────┼──────┼──────┼──────┼──────┼────────┼──────────┼─────────┼────────');
  for (const tf of TIMEFRAMES) {
    const tfLabel = TF_LABELS[tf] || tf + 'm';
    const t  = allTrades.filter(x => x.timeframe === tf + 'm');
    const w  = t.filter(x => x.outcome === 'win').length;
    const l  = t.filter(x => x.outcome === 'loss').length;
    const to = t.filter(x => x.outcome === 'timeout').length;
    const d  = w + l;
    const wr = d > 0 ? (w / d * 100).toFixed(1) + '%' : 'n/a';
    const pnl = t.reduce((s, x) => s + x.pnl, 0);
    const aw  = w > 0 ? t.filter(x => x.pnl > 0).reduce((s, x) => s + x.pnl, 0) / w : 0;
    const al  = l > 0 ? t.filter(x => x.pnl < 0).reduce((s, x) => s + Math.abs(x.pnl), 0) / l : 0;
    console.log(
      ` ${tfLabel} │` +
      `${String(t.length).padStart(5)} │` +
      `${String(w).padStart(5)} │` +
      `${String(l).padStart(5)} │` +
      `${String(to).padStart(5)} │` +
      `${wr.padStart(7)} │` +
      `$${pnl >= 0 ? ' ' : ''}${pnl.toFixed(2).padStart(8)} │` +
      `$${aw.toFixed(2).padStart(7)} │` +
      `$${al.toFixed(2)}`
    );
  }
  console.log('');

  // ─── Breakdown by symbol ──────────────────────────────────────────────────
  console.log('── BREAKDOWN BY SYMBOL ─────────────────────────────────────────────────');
  console.log(' Symbol    │Trades│  Wins│Losses│  T/O │WinRate*│   PnL');
  console.log('───────────┼──────┼──────┼──────┼──────┼────────┼──────────');
  for (const sym of PAIRS) {
    const t  = allTrades.filter(x => x.symbol === sym);
    const w  = t.filter(x => x.outcome === 'win').length;
    const l  = t.filter(x => x.outcome === 'loss').length;
    const to = t.filter(x => x.outcome === 'timeout').length;
    const d  = w + l;
    const wr = d > 0 ? (w / d * 100).toFixed(1) + '%' : 'n/a';
    const pnl = t.reduce((s, x) => s + x.pnl, 0);
    console.log(
      ` ${sym.padEnd(10)}│` +
      `${String(t.length).padStart(5)} │` +
      `${String(w).padStart(5)} │` +
      `${String(l).padStart(5)} │` +
      `${String(to).padStart(5)} │` +
      `${wr.padStart(7)} │` +
      `$${pnl >= 0 ? ' ' : ''}${pnl.toFixed(2)}`
    );
  }
  console.log('');

  fs.writeFileSync('backtest_results.json', JSON.stringify({
    config: { PAIRS, TIMEFRAMES, STARTING_CAPITAL, RISK_PER_TRADE, STOP_LOSS_PCT, TAKE_PROFIT_PCT, MAX_HOLD_BARS, CANDLE_LIMIT },
    summary: {
      startingCapital: STARTING_CAPITAL, endingCapital: +equity.toFixed(4),
      totalPnL: +totalPnL.toFixed(4), roi: +roi.toFixed(4),
      maxDrawdownPct: +(maxDD * 100).toFixed(4),
      profitFactor: isFinite(pf) ? +pf.toFixed(4) : null,
      sharpeRatio: sharpe !== null ? +sharpe.toFixed(4) : null,
      totalTrades: total, wins, losses, timeouts,
      winRate: decided > 0 ? +((wins / decided) * 100).toFixed(2) : 0,
      avgWin: +avgWin.toFixed(4), avgLoss: +avgLoss.toFixed(4),
      rewardRisk: avgLoss > 0 ? +(avgWin / avgLoss).toFixed(4) : null,
      timeoutPnL: +timeoutPnL.toFixed(4),
    },
    equityCurve,
    trades: allTrades,
  }, null, 2));

  console.log('✓ Results saved to backtest_results.json');
}

runBacktest().catch(console.error);
