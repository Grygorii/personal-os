import { connect, col, ensureIndexes } from './db.js';
import { scheduleAgents } from './runtime.js';
import { poll, setCommands, getMe } from './telegram.js';
import { route } from './router.js';
import { startServer } from './webserver.js';
import { syncWordBank } from './agents/english.js';
import * as users from './users.js';
import { runAs } from './ctx.js';
import { config } from './config.js';

// Bump on each deploy so we can confirm which build is actually live (read meta.boot).
const VERSION = 'webapp-2';

async function main() {
  await connect();
  await col('meta').updateOne({ _id: 'boot' }, { $set: { version: VERSION, at: new Date() } }, { upsert: true });
  console.log(`[boot] ${VERSION}`);
  await ensureIndexes();
  // Learn our own @username so shared result pages can link back into the bot.
  const me = await getMe();
  if (me?.username) {
    config.botUsername = me.username;
    console.log(`[boot] bot is @${me.username}`);
  }
  // The curriculum in english/*.md is the OWNER's study material, so it syncs into his
  // word bank specifically — a tenant's deck starts from their own conversations.
  if (config.telegramChatId) {
    const owner = await users.ensureUser({ chatId: config.telegramChatId });
    await runAs(owner, () => syncWordBank());
  }
  // Tappable "/" menu — buttons over typing, everywhere.
  await setCommands([
    { command: 'status', description: '📊 Level, energy, quests' },
    { command: 'review', description: '📖 Week in review' },
    { command: 'portrait', description: '🪞 Honest portrait of you' },
    { command: 'english', description: '🎧 Talk with your English tutor' },
    { command: 'done', description: '🏁 Leave English mode' },
    { command: 'pursuits', description: '🎯 Your mastery paths' },
    { command: 'ranks', description: '🏅 The rank ladder' },
    { command: 'mykey', description: '🔑 Use your own AI key' },
    { command: 'timezone', description: '🕒 When your check-ins arrive' },
    { command: 'export', description: '📦 Download all your data' },
    { command: 'help', description: '❓ Buttons & everything else' },
  ]);
  // The Mini App web face — non-fatal: a server hiccup must never take the bot down.
  try {
    startServer();
  } catch (err) {
    console.error('[web] failed to start (bot continues):', err.message);
  }
  await scheduleAgents();
  await poll(route); // runs forever, handling inbound messages
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
