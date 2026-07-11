import { connect, col } from './db.js';
import { scheduleAgents } from './runtime.js';
import { poll } from './telegram.js';
import { route } from './router.js';
import { startServer } from './webserver.js';

// Bump on each deploy so we can confirm which build is actually live (read meta.boot).
const VERSION = 'miniapp-A';

async function main() {
  await connect();
  await col('meta').updateOne({ _id: 'boot' }, { $set: { version: VERSION, at: new Date() } }, { upsert: true });
  console.log(`[boot] ${VERSION}`);
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
