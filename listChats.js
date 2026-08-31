// Lists the channels and groups on this account with their ids, so the signal
// channel can be identified for TELEGRAM_ALLOWED_CHATS without waiting for a
// signal to arrive. Read-only; private chats are skipped.
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const API_ID   = parseInt(process.env.TELEGRAM_API_ID || '0');
const API_HASH = process.env.TELEGRAM_API_HASH || '';

let session = process.env.TELEGRAM_SESSION || '';
if (!session) {
  try { session = fs.readFileSync(require('path').join(__dirname, 'telegram_session.txt'), 'utf8').trim(); } catch {}
}
if (!session) { console.error('No session found. Run: node telegramSignals.js'); process.exit(1); }

(async () => {
  const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 3 });
  await client.connect();

  const dialogs = await client.getDialogs({ limit: 200 });
  const rows = dialogs
    .filter(d => d.isChannel || d.isGroup)
    .map(d => ({
      id:       String(d.id),
      username: d.entity?.username ? '@' + d.entity.username : '',
      title:    d.title || '(unnamed)',
    }));

  console.log(`\n${rows.length} channels/groups:\n`);
  console.log('id'.padEnd(20), 'username'.padEnd(24), 'title');
  console.log('-'.repeat(80));
  for (const r of rows) {
    console.log(r.id.padEnd(20), r.username.padEnd(24), r.title);
  }
  console.log('\nUse the id (or @username) as TELEGRAM_ALLOWED_CHATS.\n');

  await client.disconnect();
  process.exit(0);
})();
