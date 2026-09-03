const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const { emaSeries, adxSeries, macdSeries } = require('./indicators.js');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// ─── Config ───────────────────────────────────────────────────────────────────
const TIMEFRAMES            = ['15', '60'];
const RISK_PCT              = 0.05;   // 5% of balance per trade
const TAKE_PROFIT_PCT       = 0.10;
const MAX_POSITIONS         = 6;
const LEVERAGE              = 20;
// Stop when this fraction of the position's margin is gone. Expressed against
// margin rather than price so it scales with leverage: a fixed price stop that
// is safe at 5x sits beyond the liquidation point at 20x and never fires.
const SL_MARGIN_PCT         = 0.75;
const STOP_LOSS_PCT         = SL_MARGIN_PCT / LEVERAGE;   // price distance
const MAX_MARGIN_PER_TRADE  = 25;   // USD committed per position (not order value)
// Kill switch. Blocks new entries only — existing positions keep being managed,
// and their TP/SL live on Bybit's servers regardless. Flip the PAUSED variable
// to stop or resume without a code change.
const PAUSED = /^(1|true|yes|on)$/i.test(process.env.PAUSED || '');
// Which entry rule to trade. 'trendfollow' is the validated one: it held up
// out-of-sample (+0.09% in, +0.51% out per trade) and was net-positive in all
// 30 parameter combinations swept. 'baseline' is the original 2-of-3 rule,
// which measured at +0.013% gross — negative once fees are paid. Kept only so
// the change is reversible without a code edit.
const STRATEGY = (process.env.STRATEGY || 'trendfollow').toLowerCase();

// Best of the sweep: highest expectancy that still produced a healthy trade
// count. ADX 35 scored marginally better but on 20% fewer opportunities.
const TF_ADX_MIN   = 30;
const TF_EMA_FAST  = 50;
const TF_EMA_SLOW  = 200;
const TF_USE_MACD  = true;

const SIGNAL_CANDLES        = 50;
// EMA200 plus MACD warmup. The old 55-candle fetch made EMA200 permanently
// null, so trend-follow would never have fired a single trade.
const CANDLES_NEEDED        = STRATEGY === 'trendfollow' ? 300 : SIGNAL_CANDLES + 5;
const RSI_PERIOD            = 14;
const BB_PERIOD             = 20;
const BB_STD                = 2;
const RSI_OVERSOLD          = 45;
const BB_SQUEEZE_THRESHOLD  = 0.2;
const HIGHER_LOWS_LOOKBACK  = 5;
const MAX_HOLD_BARS         = 20;
const POLL_INTERVAL_MS      = 60 * 1000;
const RECV_WINDOW           = 5000;
// Container filesystems are wiped on redeploy, so trade history must live on a
// mounted volume. STATE_DIR points at the mount in the cloud; locally it falls
// back to the project folder.
const STATE_DIR             = process.env.STATE_DIR || __dirname;
const STATE_FILE            = require('path').join(STATE_DIR, 'live_trades.json');

const API_KEY    = process.env.BYBIT_API_KEY;
const API_SECRET = process.env.BYBIT_API_SECRET;

if (!API_KEY || !API_SECRET) {
  console.error('❌ BYBIT_API_KEY / BYBIT_API_SECRET missing from .env'); process.exit(1);
}

// ─── Instrument cache (qty step, min qty) ────────────────────────────────────
const instrumentCache = {};

// ─── Bybit signed GET ─────────────────────────────────────────────────────────
function apiGet(path) {
  return new Promise((resolve, reject) => {
    const ts  = Date.now().toString();
    const qs  = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
    const sig = crypto.createHmac('sha256', API_SECRET).update(ts + API_KEY + RECV_WINDOW + qs).digest('hex');
    const req = https.request({
      hostname: 'api.bybit.com', path, method: 'GET',
      headers: {
        'X-BAPI-API-KEY': API_KEY, 'X-BAPI-TIMESTAMP': ts,
        'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': String(RECV_WINDOW),
        'User-Agent': 'Mozilla/5.0',
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { return resolve(JSON.parse(raw)); } catch {}
        // Bybit answers an unauthorised request with an empty body, so surface
        // the status instead of a bare JSON parse failure.
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error(`HTTP ${res.statusCode} — key rejected (check secret and IP whitelist)`));
        }
        reject(new Error(`HTTP ${res.statusCode} — unreadable response`));
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ─── Bybit signed POST ────────────────────────────────────────────────────────
function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const ts      = Date.now().toString();
    const bodyStr = JSON.stringify(body);
    const sig     = crypto.createHmac('sha256', API_SECRET).update(ts + API_KEY + RECV_WINDOW + bodyStr).digest('hex');
    const req = https.request({
      hostname: 'api.bybit.com', path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BAPI-API-KEY': API_KEY, 'X-BAPI-TIMESTAMP': ts,
        'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': String(RECV_WINDOW),
        'User-Agent': 'Mozilla/5.0',
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('parse')); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

// ─── Public candle fetch (no auth needed) ────────────────────────────────────
function fetchCandles(symbol, interval, limit = SIGNAL_CANDLES + 5) {
  return new Promise(resolve => {
    // /v5/market/kline is traded price — the series every backtest here used.
    // mark-price-kline is a liquidation reference and differs subtly, which would
    // mean the live signal is not the signal that was validated.
    const path = `/v5/market/kline?symbol=${symbol}&interval=${interval}&limit=${limit}&category=linear`;
    const req = https.get(
      { hostname: 'api.bybit.com', path, headers: { 'User-Agent': 'Mozilla/5.0' } },
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
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

// ─── Fetch all USDT linear perpetuals + futures ───────────────────────────────
let PAIRS = [];

function fetchAllPairs() {
  return new Promise(resolve => {
    let all = [], cursor = '';
    const fetchPage = () => {
      const path = `/v5/market/instruments-info?category=linear&status=Trading&limit=1000${cursor ? '&cursor=' + cursor : ''}`;
      const req = https.get({ hostname: 'api.bybit.com', path, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const r = JSON.parse(raw);
            const list = r.result?.list || [];
            // Include both perpetuals and dated futures (both USDT-settled, same API logic)
            list.filter(s => s.quoteCoin === 'USDT' && (s.contractType === 'LinearPerpetual' || s.contractType === 'LinearFutures')).forEach(s => {
              all.push(s.symbol);
              instrumentCache[s.symbol] = {
                qtyStep:     parseFloat(s.lotSizeFilter?.qtyStep     || '0.001'),
                minOrderQty: parseFloat(s.lotSizeFilter?.minOrderQty || '0.001'),
                priceTick:   parseFloat(s.priceFilter?.tickSize      || '0.01'),
              };
            });
            const next = r.result?.nextPageCursor;
            if (next && next !== cursor) { cursor = next; fetchPage(); }
            else resolve(all);
          } catch { resolve(all); }
        });
      });
      req.on('error', () => resolve(all));
      req.setTimeout(15000, () => { req.destroy(); resolve(all); });
    };
    fetchPage();
  });
}

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
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((s, p) => s + (p - sma) ** 2, 0) / period);
  return { width: (2 * mult * std) / sma };
}

function hasHigherLows(lows, lookback = HIGHER_LOWS_LOOKBACK) {
  if (lows.length < lookback + 1) return false;
  const recent = lows.slice(-lookback);
  for (let i = 1; i < recent.length; i++) if (recent[i] <= recent[i-1]) return false;
  return true;
}

// Entry rules. Both return null (no trade) or a signal object.
//
// Measured over 169k bars, 58 series, ~31 days, net of 0.15% costs:
//   baseline     +0.013% per trade gross  → negative after fees
//   trendfollow  +0.51% out-of-sample     → 30/30 sweep combinations positive
function baselineSignal(candles) {
  const closes = candles.map(c => parseFloat(c[4]));
  const lows   = candles.map(c => parseFloat(c[3]));
  const rsi = calcRSI(closes);
  const bb  = calcBB(closes);
  const s1 = rsi !== null && rsi < RSI_OVERSOLD;
  const s2 = bb  !== null && bb.width < BB_SQUEEZE_THRESHOLD;
  const s3 = hasHigherLows(lows);
  const count = [s1, s2, s3].filter(Boolean).length;
  if (count < 2) return null;
  return { count, confidence: count / 3, s1, s2, s3 };
}

// Buy strength rather than fade weakness: a confirmed trend (ADX), pointing up
// (+DI over -DI), with momentum agreeing (MACD) and the fast EMA above the slow.
function trendFollowSignal(candles) {
  const closes = candles.map(c => parseFloat(c[4]));
  const n = closes.length - 1;

  const { adx, pdi, mdi } = adxSeries(candles);
  if (adx[n] === null || adx[n] < TF_ADX_MIN) return null;
  if (!(pdi[n] > mdi[n])) return null;

  if (TF_USE_MACD) {
    const m = macdSeries(closes);
    if (!(m.line[n] !== null && m.sig[n] !== null && m.line[n] > m.sig[n])) return null;
  }

  const fast = emaSeries(closes, TF_EMA_FAST);
  const slow = emaSeries(closes, TF_EMA_SLOW);
  if (!(fast[n] !== null && slow[n] !== null && fast[n] > slow[n])) return null;

  // Confidence scales with trend strength, so stronger trends can be recorded
  // and compared later. Sizing does not currently use it.
  return {
    count: 3,
    confidence: Math.min(1, adx[n] / 50),
    adx: +adx[n].toFixed(1),
    plusDI: +pdi[n].toFixed(1),
    minusDI: +mdi[n].toFixed(1),
  };
}

function generateSignal(candles) {
  if (candles.length < (STRATEGY === 'trendfollow' ? TF_EMA_SLOW + 40 : SIGNAL_CANDLES + 1)) return null;
  return STRATEGY === 'trendfollow' ? trendFollowSignal(candles) : baselineSignal(candles);
}

// ─── Round qty to instrument step ─────────────────────────────────────────────
// Decimal places in a tick/step size. Must handle exponential notation: small
// ticks stringify as "1e-7", which has no ".", so naive splitting yields 0
// decimals and toFixed(0) collapses sub-penny prices to zero.
function decimalsOf(n) {
  const s = n.toString();
  const e = s.indexOf('e-');
  if (e !== -1) {
    const mantissa = s.slice(0, e);
    const exponent = parseInt(s.slice(e + 2), 10);
    return exponent + (mantissa.split('.')[1] || '').length;
  }
  return (s.split('.')[1] || '').length;
}

function roundQty(qty, symbol) {
  const info = instrumentCache[symbol];
  if (!info) return +qty.toFixed(3);
  const step = info.qtyStep;
  return +(Math.floor(qty / step) * step).toFixed(decimalsOf(step));
}

function roundPrice(price, symbol) {
  const info = instrumentCache[symbol];
  if (!info) return +price.toFixed(4);
  const tick = info.priceTick;
  return +(Math.round(price / tick) * tick).toFixed(decimalsOf(tick));
}

// ─── Get USDT balance ─────────────────────────────────────────────────────────
async function getBalance() {
  const r = await apiGet('/v5/account/wallet-balance?accountType=UNIFIED&coin=USDT');
  if (r.retCode !== 0) throw new Error('Balance fetch failed: ' + r.retMsg);
  const list = r.result?.list || [];
  for (const acct of list) {
    const coin = (acct.coin || []).find(c => c.coin === 'USDT');
    if (coin) return {
      equity:        parseFloat(coin.equity        || coin.walletBalance || 0),
      walletBalance: parseFloat(coin.walletBalance || 0),
      unrealisedPnl: parseFloat(coin.unrealisedPnl || 0),
    };
  }
  return { equity: 0, walletBalance: 0, unrealisedPnl: 0 };
}

// ─── Place market order with TP/SL ────────────────────────────────────────────
async function placeOrder(symbol, qty, takeProfit, stopLoss) {
  const body = {
    category:    'linear',
    symbol,
    side:        'Buy',
    orderType:   'Market',
    qty:         String(qty),
    takeProfit:  String(takeProfit),
    stopLoss:    String(stopLoss),
    tpslMode:    'Full',
    tpOrderType: 'Market',
    slOrderType: 'Market',
    timeInForce: 'IOC',
  };
  return apiPost('/v5/order/create', body);
}

// ─── Set leverage to 1x ───────────────────────────────────────────────────────
// Returns true only if the symbol is definitely at LEVERAGE. Swallowing a
// failure here silently placed orders at whatever leverage the symbol already
// carried (20x, 25x), which moves liquidation inside the stop-loss and makes
// the configured risk meaningless. The stop only protects at the leverage we
// think we have, so a failure must block the trade.
async function setLeverage(symbol) {
  try {
    const r = await apiPost('/v5/position/set-leverage', {
      category:     'linear',
      symbol,
      buyLeverage:  String(LEVERAGE),
      sellLeverage: String(LEVERAGE),
    });
    if (r.retCode === 0) return true;
    if (r.retCode === 110043) return true;   // already at this leverage
    console.log(`  \u26a0\ufe0f  Leverage ${LEVERAGE}x rejected for ${symbol}: ${r.retMsg}`);
    return false;
  } catch (e) {
    console.log(`  \u26a0\ufe0f  Leverage call failed for ${symbol}: ${e.message}`);
    return false;
  }
}

// ─── Close a position at market ───────────────────────────────────────────────
async function closePosition(symbol, qty) {
  return apiPost('/v5/order/create', {
    category:    'linear',
    symbol,
    side:        'Sell',
    orderType:   'Market',
    qty:         String(qty),
    reduceOnly:  true,
    timeInForce: 'IOC',
  });
}

// ─── State ────────────────────────────────────────────────────────────────────
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {
      // A truncated write (killed mid-save) would otherwise silently reset the
      // history to empty. Keep the damaged file so it can be recovered.
      const salvage = STATE_FILE + '.corrupt-' + Date.now();
      try { fs.renameSync(STATE_FILE, salvage); console.log(`  ⚠️  State unreadable (${e.message}) — moved to ${salvage}`); } catch {}
    }
  }
  return { openTrades: [], closedTrades: [], signals: [] };
}

function saveState(state) {
  // Never let a failed write kill the bot. Losing bookkeeping is bad; dying
  // mid-session with open positions and no supervision is worse. The position
  // count is read from Bybit, so trading survives a broken state file.
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Write to a temp file then rename. A crash partway through a direct write
    // would leave truncated JSON and lose the trade history.
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.log(`  ⚠️  Could not save state to ${STATE_FILE}: ${e.message}`);
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────
async function printSummary(state, balance) {
  const wins     = state.closedTrades.filter(t => t.outcome === 'win').length;
  const losses   = state.closedTrades.filter(t => t.outcome === 'loss').length;
  const timeouts = state.closedTrades.filter(t => t.outcome === 'timeout').length;
  const decided  = wins + losses;
  const totalPnL = state.closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);

  console.log('\n┌─────────────────────────────────────────┐');
  console.log('│            LIVE TRADING SUMMARY          │');
  console.log('├─────────────────────────────────────────┤');
  console.log(`│ Balance:     $${balance.toFixed(2).padStart(8)}                   │`);
  console.log(`│ Realised PnL: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2).padStart(7)}                   │`);
  console.log(`│ Closed:      ${String(state.closedTrades.length).padStart(4)} trades  (W:${wins} L:${losses} T/O:${timeouts})`.padEnd(43) + '│');
  console.log(`│ Win Rate*:   ${decided > 0 ? (wins/decided*100).toFixed(1)+'%' : 'n/a'}  (*excl. timeouts)`.padEnd(43) + '│');
  console.log(`│ Open:        ${String(state.openTrades.length).padStart(4)} / ${MAX_POSITIONS} positions`.padEnd(43) + '│');
  console.log(`│ Scanning:    ${String(PAIRS.length).padStart(4)} pairs × ${TIMEFRAMES.length} timeframes`.padEnd(43) + '│');
  console.log('└─────────────────────────────────────────┘');
}

// ─── Fetch all open positions from Bybit ──────────────────────────────────────
async function fetchBybitPositions() {
  try {
    const r = await apiGet('/v5/position/list?category=linear&settleCoin=USDT&limit=200');
    if (r.retCode !== 0) return null;
    const map = {};
    for (const p of (r.result?.list || [])) {
      if (parseFloat(p.size) > 0) map[p.symbol] = parseFloat(p.size);
    }
    return map;
  } catch { return null; }
}

// ─── Full account snapshot for the dashboard ──────────────────────────────────
// Everything open on the account, not just what this bot placed: the user also
// trades by hand, and a dashboard that hides those positions misrepresents the
// account's real exposure.
async function fetchAccountSnapshot() {
  const out = { positions: [], orders: [], fetchedAt: Date.now() };
  try {
    const r = await apiGet('/v5/position/list?category=linear&settleCoin=USDT&limit=200');
    if (r.retCode === 0) {
      out.positions = (r.result?.list || [])
        .filter(p => parseFloat(p.size) > 0)
        .map(p => ({
          symbol:        p.symbol,
          side:          p.side,
          leverage:      p.leverage,
          tradeMode:     p.tradeMode === 0 ? 'Cross' : 'Isolated',
          qty:           p.size,
          value:         p.positionValue,
          entryPrice:    p.avgPrice,
          markPrice:     p.markPrice,
          liqPrice:      p.liqPrice,
          breakEven:     p.breakEvenPrice || p.avgPrice,
          im:            p.positionIM,
          mm:            p.positionMM,
          unrealisedPnl: p.unrealisedPnl,
          realisedPnl:   p.curRealisedPnl,
          takeProfit:    p.takeProfit,
          stopLoss:      p.stopLoss,
          createdTime:   p.createdTime,
        }));
    }
  } catch {}
  try {
    const r = await apiGet('/v5/order/realtime?category=linear&settleCoin=USDT&limit=50');
    if (r.retCode === 0) {
      out.orders = (r.result?.list || []).map(o => ({
        symbol:      o.symbol,
        orderType:   o.orderType,
        side:        o.side,
        price:       o.price,
        qty:         o.qty,
        filled:      o.cumExecQty,
        orderValue:  (parseFloat(o.price || 0) * parseFloat(o.qty || 0)).toFixed(2),
        takeProfit:  o.takeProfit,
        stopLoss:    o.stopLoss,
        reduceOnly:  o.reduceOnly,
        createdTime: o.createdTime,
        orderId:     o.orderId,
      }));
    }
  } catch {}
  return out;
}

// ─── Bybit's own record of what a closed position actually made ───────────────
async function fetchClosedPnl(symbol, sinceMs) {
  try {
    const r = await apiGet(`/v5/position/closed-pnl?category=linear&symbol=${symbol}&limit=50`);
    if (r.retCode !== 0) return null;
    const rows = (r.result?.list || [])
      .filter(x => parseInt(x.updatedTime) >= sinceMs - 60000)
      .sort((a, b) => parseInt(b.updatedTime) - parseInt(a.updatedTime));
    if (!rows.length) return null;
    const row = rows[0];
    return {
      pnl:       parseFloat(row.closedPnl),
      exitPrice: parseFloat(row.avgExitPrice),
      exitTime:  new Date(parseInt(row.updatedTime)).toISOString(),
    };
  } catch { return null; }
}

// ─── Check open positions against Bybit reality ───────────────────────────────
async function updateOpenTrades(state) {
  const bybitPositions = await fetchBybitPositions();

  for (const trade of [...state.openTrades]) {
    const nowOnBybit = bybitPositions ? (bybitPositions[trade.symbol] ?? 0) : null;

    // ── Position closed by Bybit TP/SL since last cycle ──────────────────────
    if (bybitPositions && nowOnBybit === 0) {
      // Use Bybit's realised PnL rather than inferring one. Guessing the exit
      // from the last candle recorded fabricated results: an ambiguous close
      // was assumed to be a win at the TP price, so a position that actually
      // closed at a loss was booked as a profit at a price it never traded.
      const real = await fetchClosedPnl(trade.symbol, new Date(trade.entryTime).getTime());

      if (real) {
        const outcome = real.pnl > 0 ? 'win' : real.pnl < 0 ? 'loss' : 'breakeven';
        const emoji   = real.pnl > 0 ? '✅' : real.pnl < 0 ? '❌' : '➖';
        console.log(`  ${emoji} ${trade.symbol} ${trade.timeframe} closed | ${outcome.toUpperCase()} | PnL: $${real.pnl.toFixed(4)} @ ${real.exitPrice}`);
        state.closedTrades.push({
          ...trade, outcome,
          exitPrice: real.exitPrice,
          exitTime:  real.exitTime,
          pnl:       +real.pnl.toFixed(4),
        });
      } else {
        // Ground truth unavailable — record the close without inventing a number
        console.log(`  ⚠️  ${trade.symbol} closed but PnL unavailable from Bybit — recorded as unknown`);
        state.closedTrades.push({
          ...trade, outcome: 'unknown',
          exitTime: new Date().toISOString(),
          pnl: null,
        });
      }
      state.openTrades = state.openTrades.filter(t => t.id !== trade.id);
      continue;
    }

    // ── Still open — update barsHeld and check timeout ────────────────────────
    const candles = await fetchCandles(trade.symbol, trade.intervalRaw, 2);
    if (!candles || !candles.length) continue;

    const latest   = candles[candles.length - 1];
    const close    = parseFloat(latest[4]);
    const barTime  = parseInt(latest[0]);
    const tfMs     = parseInt(trade.intervalRaw) * 60 * 1000;
    const barsHeld = Math.floor((barTime - new Date(trade.entryTime).getTime()) / tfMs);
    trade.barsHeld = Math.max(0, barsHeld);

    if (barsHeld >= MAX_HOLD_BARS) {
      try {
        const r = await closePosition(trade.symbol, trade.qty);
        if (r.retCode !== 0) {
          if (r.retMsg.includes('position is zero')) {
            console.log(`  ℹ️  ${trade.symbol} already closed by Bybit — removing`);
            const pnl = (close - trade.entryPrice) * trade.qty;
            state.closedTrades.push({ ...trade, outcome: 'timeout', exitPrice: +close.toFixed(6), exitTime: new Date().toISOString(), pnl: +pnl.toFixed(4) });
            state.openTrades = state.openTrades.filter(t => t.id !== trade.id);
          } else {
            console.log(`  ⚠️  Timeout close failed ${trade.symbol}: ${r.retMsg} — will retry`);
          }
          continue;
        }
        const pnl = (close - trade.entryPrice) * trade.qty;
        console.log(`  ⏱️  TIMEOUT ${trade.symbol} ${trade.timeframe} | PnL: $${pnl.toFixed(4)}`);
        state.closedTrades.push({ ...trade, outcome: 'timeout', exitPrice: +close.toFixed(6), exitTime: new Date().toISOString(), pnl: +pnl.toFixed(4) });
        state.openTrades = state.openTrades.filter(t => t.id !== trade.id);
      } catch (e) {
        console.log(`  ⚠️  Timeout close error ${trade.symbol}: ${e.message}`);
      }
    }
  }
}

// ─── Scan for signals and place orders ────────────────────────────────────────
async function scanSignals(state, balance) {
  if (PAUSED) {
    console.log('  ⏸️  PAUSED — not opening new positions (existing ones still managed)');
    return;
  }
  // Bybit is the source of truth for the position count, not our local state
  // file: telegramSignals.js trades the same account and its positions are
  // invisible here. Counting locally would let the two services jointly exceed
  // MAX_POSITIONS. Fail closed if the account cannot be read.
  const livePositions = await fetchBybitPositions();
  if (!livePositions) {
    console.log('  ⛔ Cannot read open positions — skipping scan for safety');
    return;
  }
  const liveSymbols = Object.keys(livePositions);
  let openCount = liveSymbols.length;

  if (openCount >= MAX_POSITIONS) {
    console.log(`  ⏸️  At max positions (${openCount}/${MAX_POSITIONS}) — waiting for closes`);
    return;
  }

  for (const symbol of PAIRS) {
    if (openCount >= MAX_POSITIONS) break;

    // Never stack onto a symbol already held, whoever opened it
    if (liveSymbols.includes(symbol)) continue;

    for (const tf of TIMEFRAMES) {
      if (openCount >= MAX_POSITIONS) break;

      const alreadyOpen = state.openTrades.find(t => t.symbol === symbol && t.intervalRaw === tf);
      if (alreadyOpen) continue;

      const candles = await fetchCandles(symbol, tf, CANDLES_NEEDED);
      if (!candles || candles.length < SIGNAL_CANDLES + 1) continue;

      const signalCandles = candles.slice(0, -1);
      const sig = generateSignal(signalCandles);
      if (!sig) continue;

      const lastClosed  = signalCandles[signalCandles.length - 1];
      const candleId    = `${symbol}_${tf}_${lastClosed[0]}`;
      if (state.signals.find(s => s.id === candleId)) continue;

      const entryPrice  = parseFloat(lastClosed[4]);
      const takeProfit  = roundPrice(entryPrice * (1 + TAKE_PROFIT_PCT), symbol);
      const stopLoss    = roundPrice(entryPrice * (1 - STOP_LOSS_PCT), symbol);

      // Never send a zero or inverted TP/SL. A rounding fault here previously
      // sent takeProfit:0 on sub-penny coins, leaving positions with no exit.
      if (!(takeProfit > entryPrice) || !(stopLoss > 0) || !(stopLoss < entryPrice)) {
        console.log(`  ⚠️  Bad TP/SL for ${symbol} (entry ${entryPrice}, TP ${takeProfit}, SL ${stopLoss}) — skipping`);
        continue;
      }

      // Margin committed per position, capped, then levered up to get the order
      // value. Dividing by MAX_POSITIONS is what lets all slots fit at once:
      // margin used = notional / LEVERAGE.
      const margin       = Math.min(balance / MAX_POSITIONS, MAX_MARGIN_PER_TRADE);
      const positionUSDT = margin * LEVERAGE;
      if (positionUSDT < 5) continue; // Bybit minimum order value
      const rawQty  = positionUSDT / entryPrice;
      const qty     = roundQty(rawQty, symbol);
      const minQty  = instrumentCache[symbol]?.minOrderQty || 0;

      if (qty < minQty || qty <= 0 || qty * entryPrice < 5) continue;

      // Refuse the trade if leverage could not be set: the stop-loss distance
      // is only safe at the leverage we intend.
      if (!(await setLeverage(symbol))) {
        console.log(`  \u23ed\ufe0f  Skipping ${symbol} \u2014 could not confirm ${LEVERAGE}x leverage`);
        continue;
      }

      // Place the order
      let r;
      try {
        r = await placeOrder(symbol, qty, takeProfit, stopLoss);
      } catch (e) {
        console.log(`  ⚠️  Order error ${symbol}: ${e.message}`);
        continue;
      }

      if (r.retCode !== 0) {
        console.log(`  ⚠️  Order rejected ${symbol} ${tf}: ${r.retMsg}`);
        continue;
      }

      const trade = {
        id:          candleId,
        orderId:     r.result?.orderId,
        symbol,
        timeframe:   tf + 'm',
        intervalRaw: tf,
        entryTime:   new Date().toISOString(),
        entryPrice:  +entryPrice.toFixed(6),
        takeProfit,
        stopLoss,
        qty,
        positionUSDT: +positionUSDT.toFixed(4),
        barsHeld:    0,
        signals:     { count: sig.count, rsiOversold: sig.s1, bbSqueeze: sig.s2, higherLows: sig.s3 },
      };

      state.openTrades.push(trade);
      state.signals.push({ id: candleId, time: trade.entryTime });
      liveSymbols.push(symbol);
      openCount++;

      console.log(`  🟢 BOUGHT  ${symbol} ${tf}m | Entry ~$${entryPrice.toFixed(5)} | TP $${takeProfit} | SL $${stopLoss} | Qty: ${qty} | Notional: $${positionUSDT.toFixed(2)}`);
    }
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────
async function tick() {
  const now = new Date().toISOString();
  console.log(`\n⏰ ${now}`);

  const state = loadState();

  await updateOpenTrades(state);

  let balanceInfo;
  try {
    balanceInfo = await getBalance();
  } catch (e) {
    console.log('  ⚠️  Balance fetch error:', e.message);
    state.lastError = `Bybit auth failed: ${e.message}`;
    saveState(state);
    return;
  }
  delete state.lastError;   // auth is working again

  await scanSignals(state, balanceInfo.equity);
  state.balance        = balanceInfo.equity;
  state.walletBalance  = balanceInfo.walletBalance;
  state.unrealisedPnl  = balanceInfo.unrealisedPnl;
  state.maxPositions   = MAX_POSITIONS;   // published so the dashboard cannot drift
  state.leverage       = LEVERAGE;
  state.stateFile      = STATE_FILE;      // so a misconfigured volume is visible
  state.paused         = PAUSED;
  state.strategy       = STRATEGY;
  saveState(state);
  await printSummary(state, balanceInfo.equity);
}

// ─── Start ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('🚀 Live Trading Started');
  console.log(`   TP: ${TAKE_PROFIT_PCT*100}%  SL: ${STOP_LOSS_PCT*100}%  MaxHold: ${MAX_HOLD_BARS} bars`);
  console.log(`   Risk: ${RISK_PCT*100}% per trade  |  Max ${MAX_POSITIONS} positions`);
  console.log(`   Strategy: ${STRATEGY}` + (STRATEGY === 'trendfollow'
    ? `  (ADX>=${TF_ADX_MIN}, EMA${TF_EMA_FAST}/${TF_EMA_SLOW}${TF_USE_MACD ? ', MACD' : ''})` : ''));
  if (PAUSED) console.log('   ⏸️  PAUSED — no new positions will be opened.');
  console.log(`   State: ${STATE_FILE}`);
  // Surface a STATE_DIR that is configured but not actually mounted, rather
  // than letting it look persistent while silently living on ephemeral disk.
  if (process.env.STATE_DIR && !fs.existsSync(process.env.STATE_DIR)) {
    console.log(`   ⚠️  ${process.env.STATE_DIR} does not exist — no volume is mounted there.`);
    console.log('      It will be created, but history will be lost on redeploy.');
  }
  console.log('   Press Ctrl+C to stop.\n');

  // Serve the dashboard so it works from a browser when running in the cloud
  require('./dashboardServer').start(loadState, fetchAccountSnapshot);

  process.stdout.write('🔍 Fetching all Bybit USDT perpetuals...');
  PAIRS = await fetchAllPairs();
  console.log(` ${PAIRS.length} pairs found.\n`);

  // Verify API works. Deliberately non-fatal: exiting here would take the
  // dashboard down with it and leave Railway crash-looping with no way to see
  // why. Keep serving, surface the error, and let tick() retry — a bad key or a
  // changed IP whitelist is recoverable without a redeploy.
  try {
    const bal = await getBalance();
    console.log(`💰 USDT Equity: $${bal.equity.toFixed(2)}  (Wallet: $${bal.walletBalance.toFixed(2)}  Unrealised: $${bal.unrealisedPnl.toFixed(2)})\n`);
  } catch (e) {
    console.error('❌ API auth failed:', e.message);
    console.error('   Check the API key, secret, and IP whitelist.');
    console.error('   Dashboard stays up; trading is paused until auth succeeds.\n');
    const s = loadState();
    s.lastError = `Bybit auth failed: ${e.message}`;
    saveState(s);
  }

  await tick();
  setInterval(tick, POLL_INTERVAL_MS);

  setInterval(async () => {
    const updated = await fetchAllPairs();
    if (updated.length > 0) PAIRS = updated;
  }, 60 * 60 * 1000);
})();
