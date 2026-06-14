import cron from 'node-cron';
import { col } from './db.js';
import { config } from './config.js';
import * as coach from './coach.js';

// Map agent id -> scheduled handler. The coach owns the proactive pulse;
// water/book commands still work on demand via the router (no schedule needed).
const runners = {
  'coach-morning': () => coach.checkIn('morning'),
  'coach-evening': () => coach.checkIn('evening'),
};

export async function scheduleAgents() {
  const agents = await col('agents').find({ enabled: true }).toArray();

  for (const agent of agents) {
    const runner = runners[agent.id];
    if (!runner) {
      console.warn(`[runtime] no runner registered for agent "${agent.id}"`);
      continue;
    }
    if (!cron.validate(agent.schedule)) {
      console.warn(`[runtime] invalid cron for "${agent.id}": ${agent.schedule}`);
      continue;
    }

    cron.schedule(
      agent.schedule,
      async () => {
        console.log(`[runtime] running "${agent.id}"`);
        try {
          await runner();
          await col('agents').updateOne({ id: agent.id }, { $set: { lastRun: new Date() } });
        } catch (err) {
          console.error(`[runtime] "${agent.id}" failed:`, err.message);
        }
      },
      { timezone: config.timezone }
    );

    console.log(`[runtime] scheduled "${agent.id}" @ "${agent.schedule}"`);
  }
}
