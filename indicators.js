// Indicator series, shared by the live bot and the research harnesses.
//
// This module exists so that what trades is byte-for-byte what was validated.
// When the live bot and the backtester keep separate copies, they drift, and a
// backtest result stops being evidence about the thing actually running.
//
// Each function returns a full series aligned to the input index, with null
// where there is not yet enough history. Computed in a single pass — the first
// research harness recomputed over the whole window at every bar, which is
// O(n^2) and too slow to sweep.

function emaSeries(v, period) {
  const out = new Array(v.length).fill(null);
  if (v.length < period) return out;
  let prev = v.slice(0, period).reduce((a,b) => a+b, 0) / period;
  out[period-1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < v.length; i++) { prev = v[i]*k + prev*(1-k); out[i] = prev; }
  return out;
}

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i]-closes[i-1]; if (d>0) g+=d; else l-=d; }
  let ag = g/period, al = l/period;
  out[period] = 100 - 100/(1 + ag/(al || 1e-10));
  for (let i = period+1; i < closes.length; i++) {
    const d = closes[i]-closes[i-1];
    ag = (ag*(period-1) + Math.max(d,0))/period;
    al = (al*(period-1) + Math.max(-d,0))/period;
    out[i] = 100 - 100/(1 + ag/(al || 1e-10));
  }
  return out;
}

function atrSeries(c, period = 14) {
  const out = new Array(c.length).fill(null);
  const tr = new Array(c.length).fill(null);
  for (let i = 1; i < c.length; i++) {
    const h=+c[i][2], l=+c[i][3], pc=+c[i-1][4];
    tr[i] = Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
  }
  if (c.length < period+1) return out;
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr[i];
  a /= period;
  out[period] = a;
  for (let i = period+1; i < c.length; i++) { a = (a*(period-1)+tr[i])/period; out[i] = a; }
  return out;
}

function adxSeries(c, period = 14) {
  const n = c.length;
  const adx = new Array(n).fill(null), pdi = new Array(n).fill(null), mdi = new Array(n).fill(null);
  if (n < period*2 + 2) return { adx, pdi, mdi };

  const pDM = new Array(n).fill(0), mDM = new Array(n).fill(0), tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const h=+c[i][2], l=+c[i][3], ph=+c[i-1][2], pl=+c[i-1][3], pc=+c[i-1][4];
    const up = h-ph, dn = pl-l;
    pDM[i] = (up > dn && up > 0) ? up : 0;
    mDM[i] = (dn > up && dn > 0) ? dn : 0;
    tr[i]  = Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
  }
  let sTR=0, sP=0, sM=0;
  for (let i = 1; i <= period; i++) { sTR+=tr[i]; sP+=pDM[i]; sM+=mDM[i]; }

  const dx = new Array(n).fill(null);
  for (let i = period+1; i < n; i++) {
    sTR = sTR - sTR/period + tr[i];
    sP  = sP  - sP/period  + pDM[i];
    sM  = sM  - sM/period  + mDM[i];
    const p = 100*sP/(sTR||1e-10), m = 100*sM/(sTR||1e-10);
    pdi[i] = p; mdi[i] = m;
    dx[i] = 100*Math.abs(p-m)/((p+m)||1e-10);
  }
  // Wilder-smooth DX into ADX
  const first = period*2;
  if (first + period >= n) return { adx, pdi, mdi };
  let acc = 0, cnt = 0;
  for (let i = period+1; i <= first && i < n; i++) { if (dx[i] !== null) { acc += dx[i]; cnt++; } }
  if (!cnt) return { adx, pdi, mdi };
  let a = acc/cnt;
  adx[first] = a;
  for (let i = first+1; i < n; i++) {
    if (dx[i] === null) continue;
    a = (a*(period-1) + dx[i])/period;
    adx[i] = a;
  }
  return { adx, pdi, mdi };
}

function macdSeries(closes, fast = 12, slow = 26, signal = 9) {
  const n = closes.length;
  const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
  const line = new Array(n).fill(null);
  for (let i = 0; i < n; i++) if (ef[i]!==null && es[i]!==null) line[i] = ef[i]-es[i];
  // signal EMA over the defined portion of the MACD line
  const startIdx = line.findIndex(v => v !== null);
  const compact = line.slice(startIdx).map(v => v ?? 0);
  const sigCompact = emaSeries(compact, signal);
  const sig = new Array(n).fill(null);
  for (let i = 0; i < sigCompact.length; i++) sig[startIdx+i] = sigCompact[i];
  const hist = new Array(n).fill(null);
  for (let i = 0; i < n; i++) if (line[i]!==null && sig[i]!==null) hist[i] = line[i]-sig[i];
  return { line, sig, hist };
}

function bbWidthSeries(closes, period = 20, mult = 2) {
  const out = new Array(closes.length).fill(null);
  for (let i = period-1; i < closes.length; i++) {
    const s = closes.slice(i-period+1, i+1);
    const sma = s.reduce((a,b)=>a+b,0)/period;
    const sd = Math.sqrt(s.reduce((a,p)=>a+(p-sma)**2,0)/period);
    out[i] = (2*mult*sd)/sma;
  }
  return out;
}

function obvRisingSeries(c, lookback = 20) {
  const n = c.length;
  const obv = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const cl=+c[i][4], pc=+c[i-1][4], v=+c[i][5];
    obv[i] = obv[i-1] + (cl>pc ? v : cl<pc ? -v : 0);
  }
  const out = new Array(n).fill(false);
  for (let i = lookback; i < n; i++) out[i] = obv[i] > obv[i-lookback];
  return out;
}

function higherLowsSeries(c, lookback = 5) {
  const n = c.length;
  const out = new Array(n).fill(false);
  for (let i = lookback; i < n; i++) {
    let ok = true;
    for (let j = i-lookback+1; j <= i; j++) if (+c[j][3] <= +c[j-1][3]) { ok = false; break; }
    out[i] = ok;
  }
  return out;
}

module.exports = { emaSeries, rsiSeries, atrSeries, adxSeries, macdSeries, bbWidthSeries, obvRisingSeries, higherLowsSeries };
