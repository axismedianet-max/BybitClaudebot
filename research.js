// Strategy research harness.
//
// Purpose: establish what the live rules actually do, then measure whether any
// addition beats them. Every variant runs over identical candle data with
// identical trade resolution, so differences come from the entry rule alone.
//
// Nothing here touches the live bot. Run with:  node research.js
const https = require('https');
const fs = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────
const TIMEFRAMES     = ['15', '60'];
const TOP_PAIRS      = 40;      // by 24h turnover, so results reflect tradeable liquidity
const CANDLE_LIMIT   = 1000;    // Bybit max
const WARMUP         = 210;     // enough for EMA200 + MACD to be meaningful

// Matches the live configuration so the baseline is the real baseline:
// stop is 75% of margin at 20x = 3.75% of price.
const TAKE_PROFIT_PCT = 0.10;
const STOP_LOSS_PCT   = 0.0375;
const MAX_HOLD_BARS   = 20;

// Live signal thresholds
const RSI_PERIOD = 14, RSI_OVERSOLD = 45;
const BB_PERIOD = 20, BB_STD = 2, BB_SQUEEZE = 0.2;
const HIGHER_LOWS_LOOKBACK = 5;

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcRSI(closes, period = RSI_PERIOD) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; if (d > 0) g += d; else l -= d; }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (period-1) + Math.max(d, 0)) / period;
    al = (al * (period-1) + Math.max(-d, 0)) / period;
  }
  return 100 - 100 / (1 + ag / (al || 1e-10));
}

function calcBB(closes, period = BB_PERIOD, mult = BB_STD) {
  if (closes.length < period) return null;
  const s = closes.slice(-period);
  const sma = s.reduce((a,b) => a+b, 0) / period;
  const sd = Math.sqrt(s.reduce((acc,p) => acc + (p-sma)**2, 0) / period);
  return { width: (2 * mult * sd) / sma, sma };
}

function hasHigherLows(lows, lookback = HIGHER_LOWS_LOOKBACK) {
  if (lows.length < lookback + 1) return false;
  const r = lows.slice(-lookback);
  for (let i = 1; i < r.length; i++) if (r[i] <= r[i-1]) return false;
  return true;
}

// Exponential moving average — returns the full series so callers can compare
// the current value to the previous one without recomputing.
function emaSeries(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = values.slice(0, period).reduce((a,b) => a+b, 0) / period;
  out[period-1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
const emaLast = (v, p) => { const s = emaSeries(v, p); return s ? s[s.length-1] : null; };

// True Range: the greater of this bar's range, or the gap from the prior close.
// Captures overnight/illiquid gaps that a simple high-low would miss.
function trueRanges(candles) {
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const h = +candles[i][2], l = +candles[i][3], pc = +candles[i-1][4];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return tr;
}

// Average True Range — volatility in price units, so a stop can be sized to what
// the asset actually does rather than one blanket percentage across 584 pairs.
function calcATR(candles, period = 14) {
  const tr = trueRanges(candles);
  if (tr.length < period) return null;
  let atr = tr.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period-1) + tr[i]) / period;
  return atr;
}

// Average Directional Index — trend STRENGTH, direction-agnostic.
// Low ADX = ranging (mean reversion has a chance). High ADX = trending
// (fading it is how you get run over). Also returns +DI/-DI for direction.
function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < candles.length; i++) {
    const h = +candles[i][2],  l = +candles[i][3];
    const ph = +candles[i-1][2], pl = +candles[i-1][3], pc = +candles[i-1][4];
    const up = h - ph, down = pl - l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const smooth = arr => {
    let v = arr.slice(0, period).reduce((a,b) => a+b, 0);
    const out = [v];
    for (let i = period; i < arr.length; i++) { v = v - v/period + arr[i]; out.push(v); }
    return out;
  };
  const strS = smooth(tr), pS = smooth(plusDM), mS = smooth(minusDM);
  const dx = [];
  for (let i = 0; i < strS.length; i++) {
    const pdi = 100 * pS[i] / (strS[i] || 1e-10);
    const mdi = 100 * mS[i] / (strS[i] || 1e-10);
    dx.push(100 * Math.abs(pdi - mdi) / ((pdi + mdi) || 1e-10));
  }
  if (dx.length < period) return null;
  let adx = dx.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period-1) + dx[i]) / period;
  const last = strS.length - 1;
  return {
    adx,
    plusDI:  100 * pS[last] / (strS[last] || 1e-10),
    minusDI: 100 * mS[last] / (strS[last] || 1e-10),
  };
}

// MACD — direction and momentum. The histogram turning up while still negative
// is the classic early-reversal read; above zero is trend confirmation.
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
  if (!ef || !es) return null;
  const macdLine = closes.map((_, i) =>
    (ef[i] !== null && es[i] !== null) ? ef[i] - es[i] : null).filter(v => v !== null);
  const sig = emaSeries(macdLine, signal);
  if (!sig) return null;
  const n = macdLine.length - 1;
  const hist = macdLine[n] - sig[n];
  const prevHist = macdLine[n-1] - sig[n-1];
  return { macd: macdLine[n], signal: sig[n], hist, histRising: hist > prevHist };
}

// On-Balance Volume — cumulative volume signed by price direction. Rising OBV
// under flat price means accumulation; the point is whether a move has
// participation behind it or is just drift on no volume.
function calcOBV(candles, lookback = 20) {
  if (candles.length < lookback + 2) return null;
  let obv = 0;
  const series = [0];
  for (let i = 1; i < candles.length; i++) {
    const c = +candles[i][4], pc = +candles[i-1][4], v = +candles[i][5];
    obv += c > pc ? v : c < pc ? -v : 0;
    series.push(obv);
  }
  const n = series.length - 1;
  return { obv, rising: series[n] > series[n - lookback] };
}

function calcStoch(candles, kPeriod = 14) {
  if (candles.length < kPeriod) return null;
  const w = candles.slice(-kPeriod);
  const hi = Math.max(...w.map(c => +c[2]));
  const lo = Math.min(...w.map(c => +c[3]));
  const c  = +candles[candles.length-1][4];
  return 100 * (c - lo) / ((hi - lo) || 1e-10);
}

// ─── Strategy variants ────────────────────────────────────────────────────────
// Each receives the candle window up to and including the entry bar, and returns
// either null (no trade) or an object that may override the stop distance.

function baselineSignals(w) {
  const closes = w.map(c => +c[4]), lows = w.map(c => +c[3]);
  const rsi = calcRSI(closes), bb = calcBB(closes);
  const s1 = rsi !== null && rsi < RSI_OVERSOLD;
  const s2 = bb  !== null && bb.width < BB_SQUEEZE;
  const s3 = hasHigherLows(lows);
  return { count: [s1,s2,s3].filter(Boolean).length, rsi, bb };
}

const STRATEGIES = {
  // What is live today: 2 of 3, no trend or volume awareness.
  'baseline (live)': w => baselineSignals(w).count >= 2 ? {} : null,

  // Same entries, but only above the long-term trend. Tests the single biggest
  // suspected flaw: buying oversold into downtrends.
  '+ EMA200 filter': w => {
    if (baselineSignals(w).count < 2) return null;
    const closes = w.map(c => +c[4]);
    const ema = emaLast(closes, 200);
    return (ema !== null && closes[closes.length-1] > ema) ? {} : null;
  },

  // Mean reversion only where mean reversion is plausible — ranging markets.
  '+ ADX<25 (ranging)': w => {
    if (baselineSignals(w).count < 2) return null;
    const a = calcADX(w);
    return (a && a.adx < 25) ? {} : null;
  },

  // Require momentum to be turning up rather than merely oversold.
  '+ MACD hist rising': w => {
    if (baselineSignals(w).count < 2) return null;
    const m = calcMACD(w.map(c => +c[4]));
    return (m && m.histRising) ? {} : null;
  },

  // Require the move to have volume behind it.
  '+ OBV rising': w => {
    if (baselineSignals(w).count < 2) return null;
    const o = calcOBV(w);
    return (o && o.rising) ? {} : null;
  },

  // Same entries, stop sized to the asset's own volatility instead of a flat %.
  'ATR stop (2x)': w => {
    if (baselineSignals(w).count < 2) return null;
    const atr = calcATR(w);
    const price = +w[w.length-1][4];
    if (!atr || !price) return null;
    return { stopPct: Math.min(0.20, Math.max(0.01, (2 * atr) / price)) };
  },

  // All filters stacked — the strictest version of the current idea.
  'all filters': w => {
    if (baselineSignals(w).count < 2) return null;
    const closes = w.map(c => +c[4]);
    const ema = emaLast(closes, 200);
    if (!(ema !== null && closes[closes.length-1] > ema)) return null;
    const a = calcADX(w); if (!(a && a.adx < 25)) return null;
    const m = calcMACD(closes); if (!(m && m.histRising)) return null;
    return {};
  },

  // A structurally different idea: follow strength instead of fading weakness.
  'trend-follow (ADX>25)': w => {
    const closes = w.map(c => +c[4]);
    const a = calcADX(w); if (!(a && a.adx > 25 && a.plusDI > a.minusDI)) return null;
    const m = calcMACD(closes); if (!(m && m.macd > m.signal)) return null;
    const e50 = emaLast(closes, 50), e200 = emaLast(closes, 200);
    if (!(e50 && e200 && e50 > e200)) return null;
    return {};
  },
};

// ─── Trade resolution (identical for every variant) ──────────────────────────
// Walk forward bar by bar. If a bar's range covers both stop and target, count
// it as a loss — the pessimistic assumption, since intrabar order is unknown.
function resolveTrade(candles, i, entry, stopPct) {
  const sl = entry * (1 - stopPct);
  const tp = entry * (1 + TAKE_PROFIT_PCT);
  const maxBar = Math.min(candles.length - 1, i + MAX_HOLD_BARS);
  for (let j = i + 1; j <= maxBar; j++) {
    const hi = +candles[j][2], lo = +candles[j][3];
    if (lo <= sl) return { outcome: 'loss', ret: -stopPct, bars: j - i };
    if (hi >= tp) return { outcome: 'win',  ret: TAKE_PROFIT_PCT, bars: j - i };
  }
  const exit = +candles[maxBar][4];
  return { outcome: 'timeout', ret: (exit - entry) / entry, bars: maxBar - i };
}

// ─── Data ─────────────────────────────────────────────────────────────────────
function get(path) {
  return new Promise(resolve => {
    const req = https.get({ hostname: 'api.bybit.com', path, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

async function topPairs(n) {
  const r = await get('/v5/market/tickers?category=linear');
  if (!r || r.retCode !== 0) return [];
  return (r.result.list || [])
    .filter(t => t.symbol.endsWith('USDT'))
    .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
    .slice(0, n)
    .map(t => t.symbol);
}

async function candles(symbol, interval) {
  const r = await get(`/v5/market/kline?symbol=${symbol}&interval=${interval}&limit=${CANDLE_LIMIT}&category=linear`);
  if (!r || r.retCode !== 0 || !r.result?.list?.length) return null;
  return r.result.list.reverse();   // Bybit returns newest-first
}

// ─── Metrics ──────────────────────────────────────────────────────────────────
function summarise(trades) {
  if (!trades.length) return null;
  const rets = trades.map(t => t.ret);
  const wins = trades.filter(t => t.ret > 0);
  const losses = trades.filter(t => t.ret < 0);
  const gp = wins.reduce((a,t) => a + t.ret, 0);
  const gl = Math.abs(losses.reduce((a,t) => a + t.ret, 0));
  const mean = rets.reduce((a,b) => a+b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a,r) => a + (r-mean)**2, 0) / rets.length);

  // Equity curve on fixed-fraction compounding, for drawdown only
  let eq = 1, peak = 1, maxDD = 0;
  for (const t of trades) {
    eq *= (1 + t.ret * 0.1);          // 10% of equity per trade
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak);
  }
  return {
    trades: trades.length,
    winRate: wins.length / trades.length * 100,
    expectancy: mean * 100,
    pf: gl === 0 ? Infinity : gp / gl,
    sharpe: sd === 0 ? 0 : mean / sd,
    maxDD: maxDD * 100,
    avgBars: trades.reduce((a,t) => a + t.bars, 0) / trades.length,
    timeouts: trades.filter(t => t.outcome === 'timeout').length / trades.length * 100,
  };
}

// ─── Run ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('Fetching top ' + TOP_PAIRS + ' pairs by 24h turnover...');
  const pairs = await topPairs(TOP_PAIRS);
  if (!pairs.length) { console.error('Could not fetch pairs'); process.exit(1); }
  console.log('  ' + pairs.slice(0, 12).join(', ') + ', …\n');

  // Load every series once; all strategies see identical data
  const datasets = [];
  for (const tf of TIMEFRAMES) {
    process.stdout.write(`Loading ${tf}m candles `);
    for (const p of pairs) {
      const c = await candles(p, tf);
      if (c && c.length > WARMUP + MAX_HOLD_BARS + 10) datasets.push({ symbol: p, tf, candles: c });
      process.stdout.write('.');
    }
    console.log('');
  }
  const bars = datasets.reduce((a,d) => a + d.candles.length, 0);
  console.log(`\n${datasets.length} series, ${bars.toLocaleString()} bars total\n`);

  const results = {};
  for (const [name, fn] of Object.entries(STRATEGIES)) {
    const trades = [];
    for (const d of datasets) {
      const c = d.candles;
      let i = WARMUP;
      while (i < c.length - 1) {
        const w = c.slice(0, i + 1);
        let sig = null;
        try { sig = fn(w); } catch { sig = null; }
        if (!sig) { i++; continue; }
        const entry = +c[i][4];
        const r = resolveTrade(c, i, entry, sig.stopPct ?? STOP_LOSS_PCT);
        trades.push(r);
        i += r.bars + 1;          // no overlapping trades on the same series
      }
    }
    results[name] = summarise(trades);
    process.stdout.write(`  ${name} … ${trades.length} trades\n`);
  }

  // ─── Report ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(104));
  console.log('STRATEGY COMPARISON'.padStart(58));
  console.log('='.repeat(104));
  console.log(
    'strategy'.padEnd(24) + 'trades'.padStart(8) + 'win%'.padStart(8) +
    'expect%'.padStart(10) + 'PF'.padStart(8) + 'sharpe'.padStart(9) +
    'maxDD%'.padStart(9) + 'timeout%'.padStart(10) + 'avgBars'.padStart(9)
  );
  console.log('-'.repeat(104));

  const base = results['baseline (live)'];
  for (const [name, m] of Object.entries(results)) {
    if (!m) { console.log(name.padEnd(24) + '       no trades'); continue; }
    console.log(
      name.padEnd(24) +
      String(m.trades).padStart(8) +
      m.winRate.toFixed(1).padStart(8) +
      (m.expectancy >= 0 ? '+' : '') + m.expectancy.toFixed(3).padStart(9) +
      (isFinite(m.pf) ? m.pf.toFixed(2) : '∞').padStart(8) +
      m.sharpe.toFixed(3).padStart(9) +
      m.maxDD.toFixed(1).padStart(9) +
      m.timeouts.toFixed(0).padStart(10) +
      m.avgBars.toFixed(1).padStart(9)
    );
  }
  console.log('='.repeat(104));

  if (base) {
    const beRate = STOP_LOSS_PCT / (STOP_LOSS_PCT + TAKE_PROFIT_PCT) * 100;
    console.log(`\nTP ${(TAKE_PROFIT_PCT*100).toFixed(2)}%  SL ${(STOP_LOSS_PCT*100).toFixed(2)}%  →  break-even win rate ${beRate.toFixed(1)}%`);
    console.log('(timeouts exit at market, so the real bar is a positive expectancy, not that win rate)\n');
    console.log('vs baseline:');
    for (const [name, m] of Object.entries(results)) {
      if (name === 'baseline (live)' || !m) continue;
      const d = m.expectancy - base.expectancy;
      console.log(`  ${name.padEnd(24)} expectancy ${d >= 0 ? '+' : ''}${d.toFixed(3)}pp   ${d > 0 ? 'better' : 'worse'}   (${m.trades} trades)`);
    }
  }

  fs.writeFileSync('research_results.json', JSON.stringify(results, null, 2));
  console.log('\nSaved research_results.json');
})();
