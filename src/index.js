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
const VERSION = 'guestbar-fix-1';

// A rejected promise nobody caught kills the process on modern Node, and Railway restarts
// it — so the only trace of a whole class of bug was a silent restart. Log it, keep serving.
// (An uncaught exception leaves state unknown, so that one is still allowed to exit, but at
// least it says why on the way out.)
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err?.stack || err);
  process.exit(1);
});

async function main() {
  await connect();
  await col('meta').updateOne({ _id: 'boot' }, { $set: { version: VERSION, at: new Date() } }, { upsert: true });
  console.log(`[boot] ${VERSION}`);
  await ensureIndexes();
  // Bring everyone already signed up in line with the rules as they stand today. Shipping
  // a change only fixes the next person unless something walks back over the existing ones.
  const fixed = await users.reconcileAccounts();
  if (Object.keys(fixed).length) console.log('[boot] reconciled accounts:', fixed);
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
    startServer(undefined, VERSION);
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
