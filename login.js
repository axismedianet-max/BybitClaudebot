// Mints a Telegram session string and prints it. Does nothing else — no
// listening, no trading.
//
// Exists as a separate script because running the full listener locally to get
// a session is what killed the last one: Telegram invalidates an auth key the
// moment it sees the same key connect from two places, so a local run against
// the same session as the cloud deploy takes both down with AUTH_KEY_DUPLICATED.
//
//   node login.js
//
// Then paste the printed value into TELEGRAM_SESSION on the Railway listener
// service. Do not also leave it in telegram_session.txt and run the listener
// locally — one session, one place.
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const API_ID   = parseInt(process.env.TELEGRAM_API_ID || '0');
const API_HASH = process.env.TELEGRAM_API_HASH || '';

if (!API_ID || !API_HASH) {
  console.error('❌ TELEGRAM_API_ID / TELEGRAM_API_HASH missing from .env');
  process.exit(1);
}

(async () => {
  console.log('\n📱 Telegram login — this mints a new session and prints it.\n');

  // Deliberately starts from an empty session: the point is to create a new one.
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 3 });

  await client.start({
    phoneNumber: async () => await input.text('   Phone number (with country code, e.g. +1555…): '),
    password:    async () => await input.text('   2FA password (press Enter if none): '),
    phoneCode:   async () => await input.text('   Code Telegram just sent you: '),
    onError:     err => console.error('   auth error:', err),
  });

  const session = client.session.save();
  let who = '';
  try {
    const me = await client.getMe();
    who = me.username ? '@' + me.username : (me.firstName || String(me.id));
  } catch {}

  console.log(`\n✅ Logged in${who ? ' as ' + who : ''}.\n`);
  console.log('─'.repeat(72));
  console.log('TELEGRAM_SESSION — set this on the Railway listener service:');
  console.log('');
  console.log(session);
  console.log('─'.repeat(72));
  console.log('\nThis is a full login to your Telegram account, not a scoped bot');
  console.log('token. Treat it like a password.');
  console.log('\nUse it in exactly one place. If the same session runs locally and');
  console.log('in the cloud at once, Telegram kills it (AUTH_KEY_DUPLICATED) and');
  console.log('you will be back here.\n');

  await client.disconnect();
  process.exit(0);
})();
