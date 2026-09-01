// ---- The steward: its own process, its own database, its own bot ----
//
// Third deploy off this repository. Kept (src/index.js) is untouched by anything in here, and
// the two share only the plumbing — db, llm, telegram, config — which is the point of keeping
// one repo: one place to fix a connection bug, three things that cannot take each other down.
//
// Run it with `npm run start:steward` and these env vars:
//   TELEGRAM_BOT_TOKEN   a SECOND bot from @BotFather, not the coach's token
//   TELEGRAM_CHAT_ID     his chat id — the only one this bot answers
//   DB_NAME=steward      its own database on the same Atlas cluster
//   MARKET_API_KEY       Finnhub (free). Without it prices are end-of-day and there are no
//                        dividend numbers at all, which for an income strategy is most of it.
//
// Read docs/steward.md before changing the deploy.

import cron from 'node-cron';
import { connect, col } from '../db.js';
import { config, warnIfNoLlmKey } from '../config.js';
import { poll, setCommands, sendKeyboard } from '../telegram.js';
import * as bot from './bot.js';
import { ensureIndexes } from './store.js';
import { providerName } from './market.js';

const VERSION = 'steward-1';

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err?.stack || err);
  process.exit(1);
});

async function main() {
  warnIfNoLlmKey();   // this app does call a model; Pocket does not, so it never says this
  // Refusing to start beats starting against the wrong database. Sharing Kept's DB_NAME would
  // put positions in the same database as the reading app on a 512 MB cluster that also holds
  // a live shop — the exact blast radius this split exists to prevent.
  if ((config.dbName || '').toLowerCase() === 'personal_os') {
    console.error('[steward] DB_NAME is still personal_os. Set DB_NAME=steward — refusing to share Kept\'s database.');
    process.exit(1);
  }
  if (!config.telegramChatId) {
    console.error('[steward] TELEGRAM_CHAT_ID is required — this bot answers one person.');
    process.exit(1);
  }

  await connect();
  await col('meta').updateOne({ _id: 'boot' }, { $set: { version: VERSION, at: new Date() } }, { upsert: true });
  await ensureIndexes();
  console.log(`[boot] ${VERSION} · db=${config.dbName} · prices=${providerName()}`);
  if (providerName() !== 'finnhub') {
    console.warn('[steward] no MARKET_API_KEY: end-of-day prices, and no dividend data.');
  }

  await setCommands([
    { command: 'book', description: '📓 What you hold, and what it pays' },
    { command: 'review', description: '🔍 What needs your attention' },
    { command: 'idea', description: '💡 The case for and against a ticker' },
    { command: 'help', description: '❓ Everything I do' },
  ]);

  for (const job of bot.SCHEDULE) {
    cron.schedule(job.cron, () => {
      bot.runScheduled(job.id).catch((e) => console.error(`[steward] ${job.id} failed:`, e.message));
    }, { timezone: config.timezone });
    console.log(`[steward] scheduled ${job.id} (${job.cron} ${config.timezone})`);
  }

  // Put the keyboard up once at boot, so the buttons are there without him typing /start.
  await sendKeyboard('Steward is up. Prices via ' + providerName() + '.', bot.KEYBOARD).catch(() => {});
  await poll(bot.route);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
