import { connect } from './db.js';
import { scheduleAgents } from './runtime.js';
import { poll } from './telegram.js';
import { route } from './router.js';

async function main() {
  await connect();
  await scheduleAgents();
  await poll(route); // runs forever, handling inbound messages
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
