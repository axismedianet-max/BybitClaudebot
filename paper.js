const https = require('https');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// ─── Config (must match backtest) ────────────────────────────────────────────
// Pairs are fetched dynamically from Bybit — see fetchAllPairs()
let PAIRS = [];
const TIMEFRAMES      = ['15', '60'];
const STARTING_CAPITAL = 100;
const RISK_PER_TRADE  = 0.10;
const STOP_LOSS_PCT   = 0.15;
const TAKE_PROFIT_PCT = 0.10;
const MAX_HOLD_BARS   = 20;
const SIGNAL_CANDLES  = 50;
const RSI_PERIOD      = 14;
const BB_PERIOD       = 20;
const BB_STD          = 2;
const RSI_OVERSOLD    = 45;
const BB_SQUEEZE_THRESHOLD = 0.2;
const HIGHER_LOWS_LOOKBACK = 5;

const LOG_FILE = 'paper_trades.json';
const POLL_INTERVAL_MS = 60 * 1000; // check every 1 minute

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
  return { upper: sma + mult * std, lower: sma - mult * std, width: (2 * mult * std) / sma };
}

function hasHigherLows(lows, lookback = HIGHER_LOWS_LOOKBACK) {
  if (lows.length < lookback + 1) return false;
  const recent = lows.slice(-lookback);
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] <= recent[i - 1]) return false;
  }
  return true;
}

function generateSignal(candles) {
  if (candles.length < SIGNAL_CANDLES + 1) return null;
  const closes = candles.map(c => parseFloat(c[4]));
  const lows   = candles.map(c => parseFloat(c[3]));
  const rsi = calcRSI(closes);
  const bb  = calcBB(closes);
  const s1 = rsi !== null && rsi < RSI_OVERSOLD;
  const s2 = bb  !== null && bb.width < BB_SQUEEZE_THRESHOLD;
  const s3 = hasHigherLows(lows);
  const count = [s1, s2, s3].filter(Boolean).length;
  if (count < 2) return null;
  return { count, confidence: count / 3, rsi: +rsi.toFixed(2), bbWidth: +bb.width.toFixed(4), s1, s2, s3 };
}

// ─── Fetch all active USDT perpetual pairs from Bybit ────────────────────────

function fetchAllPairs() {
  return new Promise(resolve => {
    let allSymbols = [];
    let cursor = '';

    const fetchPage = () => {
      const path = `/v5/market/instruments-info?category=linear&status=Trading&limit=1000${cursor ? '&cursor=' + cursor : ''}`;
      const req = https.get(
        { hostname: 'api.bybit.com', path, headers: { 'User-Agent': 'Mozilla/5.0' }, ...(agent ? { agent } : {}) },
        res => {
          let raw = '';
          res.on('data', d => raw += d);
          res.on('end', () => {
            try {
              const r = JSON.parse(raw);
              const list = r.result?.list || [];
              // Only USDT-settled linear perpetuals (excludes USDC, inverse)
              const usdt = list
                .filter(s => s.quoteCoin === 'USDT' && s.contractType === 'LinearPerpetual')
                .map(s => s.symbol);
              allSymbols = allSymbols.concat(usdt);
              const nextCursor = r.result?.nextPageCursor;
              if (nextCursor && nextCursor !== cursor) {
                cursor = nextCursor;
                fetchPage();
              } else {
                resolve(allSymbols);
              }
            } catch { resolve(allSymbols); }
          });
        }
      );
      req.on('error', () => resolve(allSymbols));
      req.setTimeout(15000, () => { req.destroy(); resolve(allSymbols); });
    };

    fetchPage();
  });
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

function fetchCandles(symbol, interval, limit = SIGNAL_CANDLES + 5) {
  return new Promise(resolve => {
    const path = `/v5/market/mark-price-kline?symbol=${symbol}&interval=${interval}&limit=${limit}&category=linear`;
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
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

// ─── State persistence ────────────────────────────────────────────────────────

function loadState() {
  if (fs.existsSync(LOG_FILE)) {
    try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  }
  return { equity: STARTING_CAPITAL, openTrades: [], closedTrades: [], signals: [] };
}

function saveState(state) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(state, null, 2));
}

// ─── Print summary ────────────────────────────────────────────────────────────

function printSummary(state) {
  const { equity, openTrades, closedTrades } = state;
  const wins     = closedTrades.filter(t => t.outcome === 'win').length;
  const losses   = closedTrades.filter(t => t.outcome === 'loss').length;
  const timeouts = closedTrades.filter(t => t.outcome === 'timeout').length;
  const decided  = wins + losses;
  const pnl      = equity - STARTING_CAPITAL;

  console.log('\n┌─────────────────────────────────────────┐');
  console.log('│           PAPER TRADING SUMMARY          │');
  console.log('├─────────────────────────────────────────┤');
  console.log(`│ Equity:      $${equity.toFixed(2).padStart(8)}  (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`.padEnd(43) + '│');
  console.log(`│ Closed:      ${String(closedTrades.length).padStart(4)} trades  (W:${wins} L:${losses} T/O:${timeouts})`.padEnd(43) + '│');
  console.log(`│ Win Rate*:   ${decided > 0 ? (wins/decided*100).toFixed(1)+'%' : 'n/a'}  (*excl. timeouts)`.padEnd(43) + '│');
  console.log(`│ Open:        ${String(openTrades.length).padStart(4)} trade(s)`.padEnd(43) + '│');
  console.log(`│ Scanning:    ${String(PAIRS.length).padStart(4)} pairs × ${TIMEFRAMES.length} timeframes`.padEnd(43) + '│');
  console.log('└─────────────────────────────────────────┘');

  if (openTrades.length > 0) {
    console.log('\n  Open positions:');
    for (const t of openTrades) {
      const age = Math.floor((Date.now() - new Date(t.entryTime).getTime()) / 60000);
      console.log(`  · ${t.symbol} ${t.timeframe} | Entry $${t.entryPrice} | TP $${t.takeProfit.toFixed(5)} | SL $${t.stopLoss.toFixed(5)} | Age: ${age}m | Bar ${t.barsHeld}/${MAX_HOLD_BARS}`);
    }
  }
}

// ─── Check open trades against latest price ───────────────────────────────────

async function updateOpenTrades(state) {
  const toClose = [];

  for (const trade of state.openTrades) {
    const candles = await fetchCandles(trade.symbol, trade.intervalRaw, 3);
    if (!candles) continue;

    const latest = candles[candles.length - 1];
    const high   = parseFloat(latest[2]);
    const low    = parseFloat(latest[3]);
    const close  = parseFloat(latest[4]);
    const barTime = parseInt(latest[0]);

    // Count bars since entry (approximate via candle timestamps)
    const tfMs = parseInt(trade.intervalRaw) * 60 * 1000;
    const barsHeld = Math.floor((barTime - new Date(trade.entryTime).getTime()) / tfMs);
    trade.barsHeld = barsHeld;

    let outcome = null, exitPrice = null;

    if (low <= trade.stopLoss)    { outcome = 'loss';    exitPrice = trade.stopLoss; }
    else if (high >= trade.takeProfit) { outcome = 'win'; exitPrice = trade.takeProfit; }
    else if (barsHeld >= MAX_HOLD_BARS) { outcome = 'timeout'; exitPrice = close; }

    if (outcome) {
      const pnl = (exitPrice - trade.entryPrice) * trade.shares;
      state.equity += pnl;
      toClose.push({ ...trade, outcome, exitPrice: +exitPrice.toFixed(6), exitTime: new Date().toISOString(), pnl: +pnl.toFixed(4), barsHeld });

      const emoji = outcome === 'win' ? '✅' : outcome === 'loss' ? '❌' : '⏱️';
      console.log(`  ${emoji} CLOSED ${trade.symbol} ${trade.timeframe} | ${outcome.toUpperCase()} | PnL: $${pnl.toFixed(4)} | Equity: $${state.equity.toFixed(2)}`);
    }
  }

  state.openTrades   = state.openTrades.filter(t => !toClose.find(c => c.id === t.id));
  state.closedTrades.push(...toClose);
}

// ─── Scan for new signals ─────────────────────────────────────────────────────

async function scanSignals(state) {
  for (const symbol of PAIRS) {
    for (const tf of TIMEFRAMES) {
      // Skip if already in this trade
      const alreadyOpen = state.openTrades.find(t => t.symbol === symbol && t.intervalRaw === tf);
      if (alreadyOpen) continue;

      const candles = await fetchCandles(symbol, tf, SIGNAL_CANDLES + 5);
      if (!candles || candles.length < SIGNAL_CANDLES + 1) continue;

      // Use second-to-last candle (last closed bar — not the forming bar)
      const signalCandles = candles.slice(0, -1);

      const sig = generateSignal(signalCandles);
      if (!sig) continue;

      const lastClosed = signalCandles[signalCandles.length - 1];
      const entryPrice  = parseFloat(lastClosed[4]);
      const stopLoss    = entryPrice * (1 - STOP_LOSS_PCT);
      const takeProfit  = entryPrice * (1 + TAKE_PROFIT_PCT);
      const riskAmount  = state.equity * RISK_PER_TRADE * sig.confidence;
      const shares      = riskAmount / (entryPrice - stopLoss);

      const trade = {
        id:          `${symbol}_${tf}_${lastClosed[0]}`,
        symbol,
        timeframe:   tf + 'm',
        intervalRaw: tf,
        entryTime:   new Date().toISOString(),
        entryPrice:  +entryPrice.toFixed(6),
        stopLoss:    +stopLoss.toFixed(6),
        takeProfit:  +takeProfit.toFixed(6),
        shares:      +shares.toFixed(6),
        riskAmount:  +riskAmount.toFixed(4),
        barsHeld:    0,
        signals: {
          count: sig.count,
          confidence: +(sig.confidence * 100).toFixed(0) + '%',
          rsiOversold: sig.s1, bbSqueeze: sig.s2, higherLows: sig.s3,
          rsi: sig.rsi, bbWidth: sig.bbWidth,
        },
      };

      // Deduplicate — don't re-enter same signal bar
      const alreadyLogged = state.signals.find(s => s.id === trade.id);
      if (alreadyLogged) continue;

      state.openTrades.push(trade);
      state.signals.push({ id: trade.id, time: trade.entryTime });

      console.log(`  🟢 SIGNAL  ${symbol} ${tf}m | Entry $${entryPrice.toFixed(5)} | TP $${takeProfit.toFixed(5)} | SL $${stopLoss.toFixed(5)} | Signals: ${sig.count}/3 (RSI:${sig.s1?'✓':'✗'} BB:${sig.s2?'✓':'✗'} HL:${sig.s3?'✓':'✗'})`);
    }
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function tick() {
  const now = new Date().toISOString();
  console.log(`\n⏰ ${now}`);

  const state = loadState();

  await updateOpenTrades(state);
  await scanSignals(state);

  saveState(state);
  printSummary(state);
}

(async () => {
  console.log('📋 Paper Trading Started');
  console.log(`   Timeframes: ${TIMEFRAMES.map(t => t + 'm').join(', ')}`);
  console.log(`   TP: ${TAKE_PROFIT_PCT*100}%  SL: ${STOP_LOSS_PCT*100}%  MaxHold: ${MAX_HOLD_BARS} bars`);
  console.log(`   Capital: $${STARTING_CAPITAL}  |  Polling every 1 minute`);
  console.log(`   State file: ${LOG_FILE}`);
  console.log('   Press Ctrl+C to stop.\n');

  // Load full pair list on startup
  process.stdout.write('🔍 Fetching all Bybit USDT perpetuals...');
  PAIRS = await fetchAllPairs();
  console.log(` ${PAIRS.length} pairs found.\n`);

  await tick();
  setInterval(tick, POLL_INTERVAL_MS);

  // Refresh pair list every hour (new listings appear regularly)
  setInterval(async () => {
    const updated = await fetchAllPairs();
    if (updated.length > 0) {
      const newPairs = updated.filter(p => !PAIRS.includes(p));
      PAIRS = updated;
      if (newPairs.length > 0) {
        console.log(`\n🆕 ${newPairs.length} new pair(s) added: ${newPairs.join(', ')}`);
      }
    }
  }, 60 * 60 * 1000);
})();
