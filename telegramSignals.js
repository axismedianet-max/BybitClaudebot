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
const LEVERAGE = 20;
const RECV_WINDOW = 5000;

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
function parseSignal(text) {
  if (!text) return null;
  const pair     = text.match(/Trading Pair\s*:\s*(\w+)/i);
  const position = text.match(/Position\s*:\s*(LONG|SHORT)/i);
  const entry    = text.match(/Area Entry\s*:\s*([\d.]+)/i);
  const sl       = text.match(/SL\s*:\s*([\d.]+)/i);
  const tp       = text.match(/TP\s*:\s*([\d.]+)/i);
  if (!pair || !position || !sl || !tp) return null;
  const symbol = pair[1].toUpperCase().replace(/USDT$/, '') + 'USDT';
  return {
    symbol,
    side:       position[1].toUpperCase() === 'LONG' ? 'Buy' : 'Sell',
    entryPrice: entry ? parseFloat(entry[1]) : null,
    stopLoss:   parseFloat(sl[1]),
    takeProfit: parseFloat(tp[1]),
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

function roundQty(qty, step) {
  const dec = (step.toString().split('.')[1] || '').length;
  return parseFloat((Math.floor(qty / step) * step).toFixed(dec));
}

async function setLeverage(symbol) {
  try {
    await apiPost('/v5/position/set-leverage', {
      category: 'linear', symbol,
      buyLeverage: String(LEVERAGE), sellLeverage: String(LEVERAGE),
    });
  } catch {}
}

// ─── Execute trade ────────────────────────────────────────────────────────────
async function executeTrade(sig) {
  console.log(`\n📡 Signal: ${sig.symbol} ${sig.side}  TP:${sig.takeProfit}  SL:${sig.stopLoss}`);

  const [balance, price, info] = await Promise.all([
    getBalance(), getPrice(sig.symbol), getInstrumentInfo(sig.symbol),
  ]);

  if (!price) { console.log('  ⚠️  Could not get price — skipping'); return; }
  if (!info)  { console.log('  ⚠️  Unknown symbol — skipping'); return; }

  const notional = Math.max(45, balance * LEVERAGE);
  const qty      = roundQty(notional / price, info.qtyStep);

  if (qty < info.minOrderQty || qty <= 0) {
    console.log(`  ⚠️  Qty ${qty} below minimum — skipping`); return;
  }

  await setLeverage(sig.symbol);

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
  console.log(`   Leverage: ${LEVERAGE}x\n`);

  if (!API_ID || !API_HASH) {
    console.error('❌ TELEGRAM_API_ID / TELEGRAM_API_HASH missing from .env');
    process.exit(1);
  }

  const hadSession = !!loadSession();
  const session = new StringSession(loadSession());
  const client  = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 5 });

  await client.start({
    phoneNumber:  async () => await input.text('📱 Your phone number (with country code, e.g. +1234567890): '),
    password:     async () => await input.text('🔐 2FA password (leave blank if none): '),
    phoneCode:    async () => await input.text('📩 Telegram code sent to your phone: '),
    onError:      (err) => console.error('Auth error:', err),
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
  console.log('👂 Listening for signals in all channels...\n');

  client.addEventHandler(async (event) => {
    const msg  = event.message;
    const text = msg?.message || '';
    if (!text) return;

    const sig = parseSignal(text);
    if (!sig) return;

    try {
      await executeTrade(sig);
    } catch (e) {
      console.log('  ❌ Trade error:', e.message);
    }
  }, new NewMessage({}));

  // Keep alive
  await client.run();
})();
