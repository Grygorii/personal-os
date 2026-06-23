import { connect, col } from './db.js';
import { scheduleAgents } from './runtime.js';
import { poll } from './telegram.js';
import { route } from './router.js';

// Bump on each deploy so we can confirm which build is actually live (read meta.boot).
const VERSION = 'help-1';

async function main() {
  await connect();
  await col('meta').updateOne({ _id: 'boot' }, { $set: { version: VERSION, at: new Date() } }, { upsert: true });
  console.log(`[boot] ${VERSION}`);
  await scheduleAgents();
  await poll(route); // runs forever, handling inbound messages
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
