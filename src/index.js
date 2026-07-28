import { connect, col } from './db.js';
import { scheduleAgents } from './runtime.js';
import { poll, setCommands } from './telegram.js';
import { route } from './router.js';
import { startServer } from './webserver.js';
import { syncWordBank } from './agents/english.js';

// Bump on each deploy so we can confirm which build is actually live (read meta.boot).
const VERSION = 'multi-llm-1';

async function main() {
  await connect();
  await col('meta').updateOne({ _id: 'boot' }, { $set: { version: VERSION, at: new Date() } }, { upsert: true });
  console.log(`[boot] ${VERSION}`);
  await syncWordBank(); // curriculum words.md → english_words (feeds the live deck)
  // Tappable "/" menu — buttons over typing, everywhere.
  await setCommands([
    { command: 'status', description: '📊 Level, energy, quests' },
    { command: 'review', description: '📖 Week in review' },
    { command: 'portrait', description: '🪞 Honest portrait of you' },
    { command: 'english', description: '🎧 Talk with your English tutor' },
    { command: 'done', description: '🏁 Leave English mode' },
    { command: 'pursuits', description: '🎯 Your mastery paths' },
    { command: 'ranks', description: '🏅 The rank ladder' },
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
