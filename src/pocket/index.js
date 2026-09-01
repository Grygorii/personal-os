// ---- Pocket: the third deploy ----
//
// Kept (src/index.js) is the reading product. Steward (src/steward/index.js) is the investing
// journal. This is the household's money — what comes in, what goes out, what he owns across
// three currencies, and how far that is from EUR 2,000 a month in passive income.
//
//   npm run start:pocket
//
//   TELEGRAM_BOT_TOKEN   a THIRD bot from @BotFather
//   TELEGRAM_CHAT_ID     his chat id — the only one it answers
//   DB_NAME=pocket       its own database (refuses to boot on personal_os or steward)
//   MONGO_URI            same cluster
//   BASE_CURRENCY=EUR    what everything totals in
//   TZ                   Europe/Dublin — decides which month "this month" is
//
// Read docs/pocket.md before changing the deploy.

import { connect, rawCol as col } from '../db.js';
import { config } from '../config.js';
import { poll, setCommands, sendKeyboard } from '../telegram.js';
import * as bot from './bot.js';
import { ensureIndexes } from './store.js';

const VERSION = 'pocket-1';

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err?.stack || err);
  process.exit(1);
});

async function main() {
  // Three apps, three databases, one 512 MB cluster that also holds a live shop. Sharing a
  // database name is the one mistake that undoes the whole split, so it stops the boot rather
  // than being discovered later.
  const db = (config.dbName || '').toLowerCase();
  if (db === 'personal_os' || db === 'steward') {
    console.error(`[pocket] DB_NAME is "${config.dbName}". Set DB_NAME=pocket — refusing to share another app's database.`);
    process.exit(1);
  }
  if (!config.telegramChatId) {
    console.error('[pocket] TELEGRAM_CHAT_ID is required — this bot answers one person.');
    process.exit(1);
  }

  await connect();
  await col('meta').updateOne({ _id: 'boot' }, { $set: { version: VERSION, at: new Date() } }, { upsert: true });
  await ensureIndexes();
  console.log(`[boot] ${VERSION} · db=${config.dbName} · base=${config.baseCurrency}`);

  await setCommands([
    { command: 'month', description: '💶 In, out, and what is left' },
    { command: 'worth', description: '🏦 What you own, in one currency' },
    { command: 'goal', description: '🎯 Passive income, and how far' },
    { command: 'help', description: '❓ Everything I understand' },
  ]);

  await sendKeyboard(`Pocket is up. Totals in ${config.baseCurrency}.`, bot.KEYBOARD).catch(() => {});
  await poll(bot.route);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
