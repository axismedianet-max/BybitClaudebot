// Out-of-sample validation + parameter sweep.
//
// Two questions, both about whether the trend-follow edge is real:
//   1. Does it survive on data the rule was never chosen against?
//   2. Is it a plateau across parameters, or a spike at one lucky value?
//
// Indicators are precomputed as full series per dataset — the research harness
// recomputed them over the whole window at every bar, which is O(n²) and far
// too slow for a sweep.
const https = require('https');
const fs = require('fs');
// Same implementations the live bot uses, so results transfer
const { emaSeries, rsiSeries, atrSeries, adxSeries, macdSeries, bbWidthSeries, obvRisingSeries, higherLowsSeries } = require('./indicators.js');

const TIMEFRAMES   = ['15', '60'];
const TOP_PAIRS    = 30;
const CHUNKS       = 3;       // 1000 candles each, paged backwards
const WARMUP       = 260;     // EMA200 + MACD need room
const TRAIN_FRAC   = 0.6;     // chronological split; the tail is never used to choose rules

const TAKE_PROFIT_PCT = 0.10;
const STOP_LOSS_PCT   = 0.0375;
const MAX_HOLD_BARS   = 20;
const COST_PCT        = 0.15;  // taker fees both sides + slippage

// ─── Series builders (single pass each) ───────────────────────────────────────

// Wilder's ADX in one pass. Returns adx / +DI / -DI aligned to the candle index.
function buildIndicators(c) {
  const closes = c.map(x => +x[4]);
  const { adx, pdi, mdi } = adxSeries(c);
  const macd = macdSeries(closes);
  return {
    closes,
    rsi:   rsiSeries(closes),
    bbw:   bbWidthSeries(closes),
    ema50: emaSeries(closes, 50),
    ema100: emaSeries(closes, 100),
    ema200: emaSeries(closes, 200),
    ema20: emaSeries(closes, 20),
    atr:   atrSeries(c),
    adx, pdi, mdi,
    macdLine: macd.line, macdSig: macd.sig, macdHist: macd.hist,
    obvRising: obvRisingSeries(c),
    higherLows: higherLowsSeries(c),
  };
}

// ─── Rules ────────────────────────────────────────────────────────────────────

function baselineAt(ind, i) {
  const s1 = ind.rsi[i] !== null && ind.rsi[i] < 45;
  const s2 = ind.bbw[i] !== null && ind.bbw[i] < 0.2;
  const s3 = ind.higherLows[i];
  return [s1,s2,s3].filter(Boolean).length >= 2;
}

// Trend-follow, parameterised so the sweep can vary it
function trendFollowAt(ind, i, p) {
  if (ind.adx[i] === null || ind.adx[i] < p.adxMin) return false;
  if (!(ind.pdi[i] > ind.mdi[i])) return false;
  if (p.useMacd && !(ind.macdLine[i] !== null && ind.macdSig[i] !== null && ind.macdLine[i] > ind.macdSig[i])) return false;
  const f = ind['ema'+p.fast], s = ind['ema'+p.slow];
  if (!(f && s && f[i] !== null && s[i] !== null && f[i] > s[i])) return false;
  return true;
}

function resolveTrade(c, i, stopPct) {
  const entry = +c[i][4];
  const sl = entry*(1-stopPct), tp = entry*(1+TAKE_PROFIT_PCT);
  const maxBar = Math.min(c.length-1, i+MAX_HOLD_BARS);
  for (let j = i+1; j <= maxBar; j++) {
    if (+c[j][3] <= sl) return { ret: -stopPct, bars: j-i, outcome: 'loss' };
    if (+c[j][2] >= tp) return { ret: TAKE_PROFIT_PCT, bars: j-i, outcome: 'win' };
  }
  return { ret: (+c[maxBar][4]-entry)/entry, bars: maxBar-i, outcome: 'timeout' };
}

function runRule(datasets, test, range) {
  const trades = [];
  for (const d of datasets) {
    const { candles: c, ind } = d;
    const lo = Math.max(WARMUP, Math.floor(c.length*range[0]));
    const hi = Math.floor(c.length*range[1]);
    let i = lo;
    while (i < hi-1) {
      if (!test(ind, i)) { i++; continue; }
      const r = resolveTrade(c, i, STOP_LOSS_PCT);
      trades.push(r);
      i += r.bars + 1;
    }
  }
  return trades;
}

function stats(trades) {
  if (trades.length < 10) return null;
  const rets = trades.map(t => t.ret);
  const wins = rets.filter(r => r > 0), losses = rets.filter(r => r < 0);
  const gp = wins.reduce((a,b)=>a+b,0), gl = Math.abs(losses.reduce((a,b)=>a+b,0));
  const mean = rets.reduce((a,b)=>a+b,0)/rets.length;
  const sd = Math.sqrt(rets.reduce((a,r)=>a+(r-mean)**2,0)/rets.length);
  return {
    trades: trades.length,
    winRate: wins.length/trades.length*100,
    gross: mean*100,
    net: mean*100 - COST_PCT,
    pf: gl===0 ? Infinity : gp/gl,
    sharpe: sd===0 ? 0 : mean/sd,
  };
}

// ─── Data ─────────────────────────────────────────────────────────────────────
function get(path) {
  return new Promise(resolve => {
    const req = https.get({ hostname:'api.bybit.com', path, headers:{'User-Agent':'Mozilla/5.0'} }, res => {
      let raw=''; res.on('data',d=>raw+=d);
      res.on('end',()=>{ try{resolve(JSON.parse(raw));}catch{resolve(null);} });
    });
    req.on('error',()=>resolve(null));
    req.setTimeout(20000,()=>{req.destroy();resolve(null);});
  });
}

async function topPairs(n) {
  const r = await get('/v5/market/tickers?category=linear');
  if (!r || r.retCode !== 0) return [];
  return (r.result.list||[]).filter(t=>t.symbol.endsWith('USDT'))
    .sort((a,b)=>parseFloat(b.turnover24h)-parseFloat(a.turnover24h))
    .slice(0,n).map(t=>t.symbol);
}

// Page backwards so there is enough history for a genuine train/test split
async function history(symbol, interval, chunks) {
  let all = [], end = Date.now();
  for (let k = 0; k < chunks; k++) {
    const r = await get(`/v5/market/kline?symbol=${symbol}&interval=${interval}&limit=1000&category=linear&end=${end}`);
    if (!r || r.retCode !== 0 || !r.result?.list?.length) break;
    const page = r.result.list.slice().reverse();
    all = page.concat(all);
    end = parseInt(page[0][0]) - 1;
    if (page.length < 1000) break;
  }
  // de-duplicate by timestamp, keep chronological
  const seen = new Set(); const out = [];
  for (const c of all) { const t = c[0]; if (!seen.has(t)) { seen.add(t); out.push(c); } }
  return out;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const pairs = await topPairs(TOP_PAIRS);
  console.log(`Loading history for ${pairs.length} pairs × ${TIMEFRAMES.length} timeframes × ${CHUNKS}k candles`);

  const datasets = [];
  for (const tf of TIMEFRAMES) {
    process.stdout.write(`  ${tf}m `);
    for (const p of pairs) {
      const c = await history(p, tf, CHUNKS);
      if (c.length > WARMUP + 200) datasets.push({ symbol:p, tf, candles:c, ind: buildIndicators(c) });
      process.stdout.write('.');
    }
    console.log('');
  }
  const bars = datasets.reduce((a,d)=>a+d.candles.length,0);
  console.log(`\n${datasets.length} series, ${bars.toLocaleString()} bars`);
  const span = datasets[0] ? (parseInt(datasets[0].candles[datasets[0].candles.length-1][0]) - parseInt(datasets[0].candles[0][0]))/86400000 : 0;
  console.log(`${datasets[0]?.candles.length ?? 0} bars per 15m series ≈ ${span.toFixed(0)} days\n`);

  const IN = [0, TRAIN_FRAC], OUT = [TRAIN_FRAC, 1];

  // ═══ 1. Out-of-sample ═══════════════════════════════════════════════════════
  console.log('='.repeat(88));
  console.log('  OUT-OF-SAMPLE TEST — rules were chosen on the first 60%, tested on the last 40%');
  console.log('='.repeat(88));
  const tfDefault = { adxMin:25, useMacd:true, fast:50, slow:200 };
  const rules = {
    'baseline (live)':      (ind,i) => baselineAt(ind,i),
    'trend-follow':         (ind,i) => trendFollowAt(ind,i,tfDefault),
  };
  console.log('rule'.padEnd(20)+'period'.padEnd(9)+'trades'.padStart(8)+'win%'.padStart(8)+
              'gross%'.padStart(9)+'net%'.padStart(9)+'PF'.padStart(8)+'sharpe'.padStart(9));
  console.log('-'.repeat(88));
  const oos = {};
  for (const [name, fn] of Object.entries(rules)) {
    for (const [label, range] of [['in',IN],['OUT',OUT]]) {
      const s = stats(runRule(datasets, fn, range));
      if (!s) { console.log(name.padEnd(20)+label.padEnd(9)+'  too few trades'); continue; }
      oos[name+'/'+label] = s;
      console.log(
        name.padEnd(20)+label.padEnd(9)+
        String(s.trades).padStart(8)+s.winRate.toFixed(1).padStart(8)+
        ((s.gross>=0?'+':'')+s.gross.toFixed(3)).padStart(9)+
        ((s.net>=0?'+':'')+s.net.toFixed(3)).padStart(9)+
        (isFinite(s.pf)?s.pf.toFixed(2):'∞').padStart(8)+
        s.sharpe.toFixed(3).padStart(9)
      );
    }
  }

  console.log('');
  for (const name of Object.keys(rules)) {
    const a = oos[name+'/in'], b = oos[name+'/OUT'];
    if (!a || !b) continue;
    const holds = b.net > 0 && b.net > a.net * 0.4;
    console.log(`  ${name.padEnd(18)} in ${a.net>=0?'+':''}${a.net.toFixed(3)}%  →  out ${b.net>=0?'+':''}${b.net.toFixed(3)}%   ` +
                (holds ? 'EDGE HOLDS' : b.net > 0 ? 'weakened but positive' : 'EDGE GONE'));
  }

  // ═══ 2. Parameter sweep ═════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(88));
  console.log('  PARAMETER SWEEP — is trend-follow a plateau, or a spike at one lucky value?');
  console.log('='.repeat(88));
  const grid = [];
  for (const adxMin of [15,20,25,30,35])
    for (const [fast,slow] of [[20,100],[50,200],[20,50]])
      for (const useMacd of [true,false])
        grid.push({ adxMin, fast, slow, useMacd });

  const sweep = [];
  for (const p of grid) {
    const s = stats(runRule(datasets, (ind,i)=>trendFollowAt(ind,i,p), [0,1]));
    if (s) sweep.push({ ...p, ...s });
  }
  sweep.sort((a,b)=>b.net-a.net);

  console.log('adx'.padStart(5)+'ema'.padStart(10)+'macd'.padStart(7)+
              'trades'.padStart(8)+'win%'.padStart(8)+'net%'.padStart(9)+'PF'.padStart(8)+'sharpe'.padStart(9));
  console.log('-'.repeat(88));
  for (const r of sweep) {
    console.log(
      String(r.adxMin).padStart(5)+
      `${r.fast}/${r.slow}`.padStart(10)+
      (r.useMacd?'yes':'no').padStart(7)+
      String(r.trades).padStart(8)+
      r.winRate.toFixed(1).padStart(8)+
      ((r.net>=0?'+':'')+r.net.toFixed(3)).padStart(9)+
      (isFinite(r.pf)?r.pf.toFixed(2):'∞').padStart(8)+
      r.sharpe.toFixed(3).padStart(9)
    );
  }

  const positive = sweep.filter(r => r.net > 0).length;
  console.log('-'.repeat(88));
  console.log(`${positive}/${sweep.length} parameter combinations are net-positive after ${COST_PCT}% costs.`);
  console.log(positive >= sweep.length * 0.7
    ? 'Broad plateau — the edge is not an artifact of one parameter choice.'
    : positive >= sweep.length * 0.4
      ? 'Mixed — edge exists but is parameter-sensitive. Treat with caution.'
      : 'Narrow — most settings lose. This looks like curve-fitting.');

  fs.writeFileSync('validate_results.json', JSON.stringify({ oos, sweep }, null, 2));
  console.log('\nSaved validate_results.json');
})();
