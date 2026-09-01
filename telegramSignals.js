const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// ─── Config ───────────────────────────────────────────────────────────────────
const API_ID   = parseInt(process.env.TELEGRAM_API_ID || '0');
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const LEVERAGE      = 20;
const MAX_POSITIONS = 6;    // matches BybitClaudebot.js — counted live from Bybit
const MAX_MARGIN_PER_TRADE = 25;   // USD committed per position (not order value)
// Cap on how much of a position's margin a stop may risk. Signal channels quote
// stops for unleveraged sizing — the FIL signal's stop sat ~9.8% from entry,
// which at 20x is past the liquidation point and would never have fired. The
// tighter of (channel stop, this cap) is used so a stop always exists.
const SL_MARGIN_PCT = 0.75;
const RECV_WINDOW   = 5000;

// Chats permitted to trigger a trade, by id or @username. Empty means
// observe-only: signals are logged with their chat id but nothing is placed.
// Deliberately fail-closed — a message in the signal format can arrive from any
// chat, so an unfiltered listener would let a stranger's DM open a position.
const ALLOWED = (process.env.TELEGRAM_ALLOWED_CHATS || '')
  .split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);

// Telegram reports a channel id two ways: the marked form -1001350671338 that
// getDialogs returns, and the bare 1350671338 that getChat often gives inside an
// event. Compare on the bare digits so either form in the allowlist matches, and
// a configuration that looks right cannot silently ignore every signal.
function bareId(v) { return String(v).replace(/^-?(100)?/, ''); }

// Canonical numeric ids for any @usernames in ALLOWED, filled in at startup.
const RESOLVED_IDS = [];
const RESOLVED_NAMES = {};
function idMatches(chatId, allowed) {
  if (!chatId) return false;
  const bare = bareId(chatId);
  return allowed.some(a => /^-?\d+$/.test(a) && bareId(a) === bare);
}

const API_KEY    = process.env.BYBIT_API_KEY;
const API_SECRET = process.env.BYBIT_API_SECRET;
const SESSION_FILE = require('path').join(__dirname, 'telegram_session.txt');

// ─── Session persistence ──────────────────────────────────────────────────────
// In the cloud there is no stdin to type a login code into, so the session
// string is supplied via TELEGRAM_SESSION. Locally it falls back to the file.
function loadSession() {
  if (process.env.TELEGRAM_SESSION) return process.env.TELEGRAM_SESSION.trim();
  try { return fs.readFileSync(SESSION_FILE, 'utf8').trim(); } catch { return ''; }
}
function saveSession(str) {
  try { fs.writeFileSync(SESSION_FILE, str); } catch {}
}

// ─── Parse signal ─────────────────────────────────────────────────────────────
// The channel posts in two layouts and switched between them mid-August, so
// both must parse. Old:  "Trading Pair : FIL / Position : LONG / TP : 0.863"
// New:  "Trading Pair: #AXLUSDT / LONG Setup / TP1: $0.0475 / SL: $0.0415",
// with $ signs, thousands commas, en-dash entry ranges and numbered targets.
function parseSignal(text) {
  if (!text) return null;

  // "$76,877" and "0.0443" both have to survive
  const num = v => parseFloat(String(v).replace(/[$,\s]/g, ''));

  // "Trading Pair : FIL" | "Trading Pair: #AXLUSDT"
  const pair = text.match(/Trading\s*Pair\s*:?\s*#?([A-Za-z0-9]+)/i);
  if (!pair) return null;

  // "Position : LONG" (old) | "LONG Setup" (new)
  const dir = text.match(/Position\s*:\s*(LONG|SHORT)/i)
           || text.match(/\b(LONG|SHORT)\s+Setup/i);
  if (!dir) return null;

  // "SL : 0.6" | "SL: $0.0415" | "Stop Loss: $75,466"
  const slM = text.match(/(?:\bSL\b|Stop\s*Loss)\s*:?\s*\$?\s*([\d,]+\.?\d*)/i);
  if (!slM) return null;

  // Prefer TP1 — the nearest target, and the one most likely to be reached.
  // Falls back to the old format's single "TP".
  const tpM = text.match(/\bTP\s*1\s*:?\s*\$?\s*([\d,]+\.?\d*)/i)
           || text.match(/\bTP\s*:?\s*\$?\s*([\d,]+\.?\d*)/i);
  if (!tpM) return null;

  // Entry may be absent, a single value, or a range — the first number is enough,
  // and only used for sanity checks since entries are market orders.
  const enM = text.match(/(?:Area\s+)?\bEntry\b\s*:?\s*\$?\s*([\d,]+\.?\d*)/i);

  const stopLoss   = num(slM[1]);
  const takeProfit = num(tpM[1]);
  if (!(stopLoss > 0) || !(takeProfit > 0)) return null;

  return {
    symbol:     pair[1].toUpperCase().replace(/USDT$/, '') + 'USDT',
    side:       dir[1].toUpperCase() === 'LONG' ? 'Buy' : 'Sell',
    entryPrice: enM ? num(enM[1]) : null,
    stopLoss,
    takeProfit,
  };
}


// ─── Bybit API ────────────────────────────────────────────────────────────────
function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const ts = Date.now().toString();
    const payload = JSON.stringify(body);
    const sig = crypto.createHmac('sha256', API_SECRET).update(ts + API_KEY + RECV_WINDOW + payload).digest('hex');
    const req = https.request({
      hostname: 'api.bybit.com', path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BAPI-API-KEY': API_KEY, 'X-BAPI-TIMESTAMP': ts,
        'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': String(RECV_WINDOW),
      },
    }, res => { let r = ''; res.on('data', d => r += d); res.on('end', () => { try { resolve(JSON.parse(r)); } catch { reject(new Error('parse')); } }); });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const ts  = Date.now().toString();
    const qs  = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
    const sig = crypto.createHmac('sha256', API_SECRET).update(ts + API_KEY + RECV_WINDOW + qs).digest('hex');
    const req = https.request({
      hostname: 'api.bybit.com', path, method: 'GET',
      headers: { 'X-BAPI-API-KEY': API_KEY, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': String(RECV_WINDOW) },
    }, res => { let r = ''; res.on('data', d => r += d); res.on('end', () => { try { resolve(JSON.parse(r)); } catch { reject(new Error('parse')); } }); });
    req.on('error', reject);
    req.end();
  });
}

async function getBalance() {
  const r = await apiGet('/v5/account/wallet-balance?accountType=UNIFIED&coin=USDT');
  const coin = r.result?.list?.[0]?.coin?.find(c => c.coin === 'USDT');
  return parseFloat(coin?.walletBalance || 0);
}

async function getPrice(symbol) {
  const r = await apiGet(`/v5/market/tickers?category=linear&symbol=${symbol}`);
  return parseFloat(r.result?.list?.[0]?.lastPrice || 0);
}

async function getInstrumentInfo(symbol) {
  const r = await apiGet(`/v5/market/instruments-info?category=linear&symbol=${symbol}`);
  const info = r.result?.list?.[0];
  if (!info) return null;
  return {
    qtyStep:     parseFloat(info.lotSizeFilter?.qtyStep     || '0.001'),
    minOrderQty: parseFloat(info.lotSizeFilter?.minOrderQty || '0.001'),
  };
}

// Must handle exponential notation: a small step stringifies as "1e-7", which
// has no ".", so naive splitting yields 0 decimals and toFixed(0) collapses the
// value to zero.
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

function roundQty(qty, step) {
  return parseFloat((Math.floor(qty / step) * step).toFixed(decimalsOf(step)));
}

// Returns true only if the symbol is definitely at LEVERAGE. A swallowed
// failure placed orders at whatever leverage the symbol already carried, which
// moves liquidation inside the stop-loss and makes the configured risk
// meaningless — so a failure must block the trade.
async function setLeverage(symbol) {
  try {
    const r = await apiPost('/v5/position/set-leverage', {
      category: 'linear', symbol,
      buyLeverage: String(LEVERAGE), sellLeverage: String(LEVERAGE),
    });
    if (r.retCode === 0 || r.retCode === 110043) return true;
    console.log(`  \u26a0\ufe0f  Leverage ${LEVERAGE}x rejected for ${symbol}: ${r.retMsg}`);
    return false;
  } catch (e) {
    console.log(`  \u26a0\ufe0f  Leverage call failed for ${symbol}: ${e.message}`);
    return false;
  }
}

// ─── Open positions currently held on Bybit ───────────────────────────────────
async function fetchOpenPositions() {
  const r = await apiGet('/v5/position/list?category=linear&settleCoin=USDT&limit=200');
  if (r.retCode !== 0) throw new Error(r.retMsg || 'position list failed');
  return (r.result?.list || [])
    .filter(p => parseFloat(p.size) > 0)
    .map(p => p.symbol);
}

// ─── Execute trade ────────────────────────────────────────────────────────────
async function executeTrade(sig) {
  console.log(`\n📡 Signal: ${sig.symbol} ${sig.side}  TP:${sig.takeProfit}  SL:${sig.stopLoss}`);

  // Bybit is the source of truth for how many positions are open. If this call
  // fails we skip the trade rather than risk stacking on an unknown position.
  let openSymbols;
  try {
    openSymbols = await fetchOpenPositions();
  } catch (e) {
    console.log(`  ⛔ Cannot read open positions (${e.message}) — skipping for safety`);
    return;
  }

  if (openSymbols.includes(sig.symbol)) {
    console.log(`  ⏭️  Already holding ${sig.symbol} — skipping duplicate`);
    return;
  }

  if (openSymbols.length >= MAX_POSITIONS) {
    console.log(`  ⏸️  At max positions (${openSymbols.length}/${MAX_POSITIONS}) — skipping`);
    console.log(`      Holding: ${openSymbols.join(', ')}`);
    return;
  }

  const [balance, price, info] = await Promise.all([
    getBalance(), getPrice(sig.symbol), getInstrumentInfo(sig.symbol),
  ]);

  if (!price) { console.log('  ⚠️  Could not get price — skipping'); return; }
  if (!info)  { console.log('  ⚠️  Unknown symbol — skipping'); return; }

  // Reject a signal whose levels make no sense for the direction, so a bad
  // parse or a typo in the channel cannot open a position with no exit.
  const tpOk = sig.side === 'Buy' ? sig.takeProfit > price : sig.takeProfit < price;
  const slOk = sig.side === 'Buy' ? sig.stopLoss  < price : sig.stopLoss  > price;
  if (!(sig.takeProfit > 0) || !(sig.stopLoss > 0) || !tpOk || !slOk) {
    console.log(`  ⚠️  Implausible levels for ${sig.side} at ${price} (TP ${sig.takeProfit}, SL ${sig.stopLoss}) — skipping`);
    return;
  }

  // Pull the stop inside the liquidation point if the channel's is too wide.
  // Signal channels quote stops for unleveraged sizing: the FIL signal's stop
  // sat ~9.8% from entry, which at 20x is past liquidation and would never fire.
  const maxDist = price * (SL_MARGIN_PCT / LEVERAGE);
  const channelDist = Math.abs(price - sig.stopLoss);
  if (channelDist > maxDist) {
    const capped = sig.side === 'Buy' ? price - maxDist : price + maxDist;
    console.log(`  \u2702\ufe0f  Channel stop ${sig.stopLoss} is ${(channelDist / price * 100).toFixed(1)}% away \u2014 past liquidation at ${LEVERAGE}x.`);
    console.log(`     Tightening to ${+capped.toFixed(8)} (${SL_MARGIN_PCT * 100}% of margin).`);
    sig.stopLoss = +capped.toFixed(8);
  }

  // Margin committed per position, capped, then levered up to get the order
  // value. Dividing by MAX_POSITIONS is what lets all slots fit at once:
  // margin used = notional / LEVERAGE.
  const margin   = Math.min(balance / MAX_POSITIONS, MAX_MARGIN_PER_TRADE);
  const notional = margin * LEVERAGE;
  const qty      = roundQty(notional / price, info.qtyStep);

  if (qty < info.minOrderQty || qty <= 0) {
    console.log(`  ⚠️  Qty ${qty} below minimum — skipping`); return;
  }

  if (!(await setLeverage(sig.symbol))) {
    console.log(`  \u23ed\ufe0f  Skipping ${sig.symbol} \u2014 could not confirm ${LEVERAGE}x leverage`);
    return;
  }

  const r = await apiPost('/v5/order/create', {
    category:    'linear',
    symbol:      sig.symbol,
    side:        sig.side,
    orderType:   'Market',
    qty:         String(qty),
    takeProfit:  String(sig.takeProfit),
    stopLoss:    String(sig.stopLoss),
    tpOrderType: 'Market',
    slOrderType: 'Market',
    tpslMode:    'Full',
    timeInForce: 'IOC',
  });

  if (r.retCode === 0) {
    console.log(`  ✅ ${sig.symbol} ${sig.side} qty:${qty} | TP:${sig.takeProfit} SL:${sig.stopLoss}`);
  } else {
    console.log(`  ❌ Order failed: ${r.retMsg}`);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('📡 BybitClaudebot — Telegram Signal Listener');
  console.log(`   Leverage: ${LEVERAGE}x  |  Max ${MAX_POSITIONS} positions\n`);

  if (!API_ID || !API_HASH) {
    console.error('❌ TELEGRAM_API_ID / TELEGRAM_API_HASH missing from .env');
    process.exit(1);
  }

  const hadSession = !!loadSession();
  const session = new StringSession(loadSession());
  const client  = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 5 });

  // Interactive login needs a phone code typed at a prompt. In the cloud there
  // is no stdin, so a rejected session would block forever on a question nobody
  // can answer — the service would look healthy while doing nothing. Fail loudly
  // instead.
  const interactive = process.stdin.isTTY;
  const noPrompt = (what) => async () => {
    console.error(`\n❌ Telegram wants ${what}, but there is no terminal to ask.`);
    console.error('   TELEGRAM_SESSION is missing or no longer valid.');
    console.error('   Run this locally to mint a fresh session, then set it here.\n');
    process.exit(1);
  };

  await client.start({
    phoneNumber: interactive ? async () => await input.text('📱 Phone number (with country code): ') : noPrompt('a phone number'),
    password:    interactive ? async () => await input.text('🔐 2FA password (blank if none): ')     : noPrompt('a 2FA password'),
    phoneCode:   interactive ? async () => await input.text('📩 Code sent to your phone: ')          : noPrompt('a login code'),
    onError:     (err) => console.error('Auth error:', err),
  });

  const sessionString = client.session.save();
  saveSession(sessionString);
  console.log('✅ Logged in to Telegram\n');

  if (!hadSession) {
    console.log('━'.repeat(70));
    console.log('TELEGRAM_SESSION — copy this into Railway as an environment variable');
    console.log('so the cloud deploy can log in without a phone code:\n');
    console.log(sessionString);
    console.log('━'.repeat(70) + '\n');
  }
  // Resolve any @usernames in the allowlist to their numeric ids up front, so
  // matching is purely numeric at message time and does not depend on the event
  // carrying a readable name.
  for (const a of ALLOWED) {
    if (/^-?\d+$/.test(a)) continue;
    try {
      const ent = await client.getEntity(a);
      const id  = bareId(String(ent.id));
      RESOLVED_IDS.push(id);
      RESOLVED_NAMES[id] = ent.username || ent.title || a;
      console.log(`   resolved ${a} → id ${ent.id}`);
    } catch (e) {
      console.log(`   ⚠️  could not resolve ${a}: ${e.message}`);
    }
  }

  if (ALLOWED.length) {
    console.log(`👂 Listening. Trading only signals from: ${ALLOWED.join(', ')}\n`);
  } else {
    console.log('👂 Listening in OBSERVE-ONLY mode — no orders will be placed.');
    console.log('   Signals will be logged with their chat id. Put the id of your');
    console.log('   signal channel in TELEGRAM_ALLOWED_CHATS to enable trading.\n');
  }

  client.addEventHandler(async (event) => {
    const msg  = event.message;
    const text = msg?.message || '';
    if (!text) return;

    const sig = parseSignal(text);
    if (!sig) return;

    // Identify the source. A message matching the signal format can arrive from
    // any chat — including a private message from a stranger — so the sender is
    // untrusted input and must be checked before it can move money.
    //
    // Read the id off the message itself. getChat() returned an object with no
    // id, username or title here, which made every signal look like it came
    // from an unknown chat and silently blocked all of them.
    const msgObj = event.message || {};
    const chatId = String(
      msgObj.chatId ??
      msgObj.peerId?.channelId ??
      msgObj.peerId?.chatId ??
      msgObj.peerId?.userId ??
      ''
    );
    let chatName = '';
    try {
      const chat = await event.getChat();
      chatName = chat?.username || chat?.title || '';
    } catch {}
    if (!chatName) chatName = RESOLVED_NAMES[bareId(chatId)] || '(unnamed)';

    if (!ALLOWED.length) {
      console.log(`\n👁  Observed ${sig.symbol} ${sig.side} from "${chatName}" (id ${chatId})`);
      console.log('   Not trading — TELEGRAM_ALLOWED_CHATS is unset.');
      return;
    }

    const permitted = idMatches(chatId, ALLOWED) ||
                      idMatches(chatId, RESOLVED_IDS) ||
                      ALLOWED.some(a => a.toLowerCase() === String(chatName).toLowerCase());
    if (!permitted) {
      console.log(`\n⛔ Ignored ${sig.symbol} ${sig.side} from "${chatName}" (id ${chatId}) — not an allowed chat`);
      return;
    }

    console.log(`\n📨 Signal from "${chatName}"`);
    try {
      await executeTrade(sig);
    } catch (e) {
      console.log('  ❌ Trade error:', e.message);
    }
  }, new NewMessage({}));

  // gramJS has no run(), and its `disconnected` member is a boolean rather than
  // a promise, so there is nothing to await — awaiting it exits immediately.
  // Hold the process open explicitly, and watch the connection: a listener that
  // is running but disconnected would silently miss every signal, which looks
  // identical to a quiet channel.
  setInterval(async () => {
    if (client.connected) return;
    console.error('⚠️  Telegram disconnected — reconnecting...');
    try {
      await client.connect();
      console.log('✓ Reconnected');
    } catch (e) {
      console.error(`❌ Reconnect failed: ${e.message} — exiting so the platform restarts.`);
      process.exit(1);
    }
  }, 60000);

  await new Promise(() => {});   // keep alive; the event handler does the work
})();
