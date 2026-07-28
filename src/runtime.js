import cron from 'node-cron';
import { col } from './db.js';
import { config } from './config.js';
import * as coach from './coach.js';
import * as users from './users.js';
import { runAs } from './ctx.js';

// Map agent id -> scheduled handler. The coach owns the proactive pulse;
// water/book commands still work on demand via the router (no schedule needed).
const runners = {
  'coach-morning': () => coach.checkIn('morning'),
  'coach-evening': () => coach.checkIn('evening'),
  'coach-weekly': () => coach.weeklyReview(),
};

// Canonical agents, upserted on boot so new ones register on deploy without a
// manual re-seed. $setOnInsert means existing rows (and any custom schedules) are left alone.
const DEFAULT_AGENTS = [
  { id: 'coach-morning', enabled: true, schedule: '0 8 * * *', channel: 'telegram', description: 'Morning check-in — opens the day.' },
  { id: 'coach-evening', enabled: true, schedule: '0 21 * * *', channel: 'telegram', description: 'Evening check-in — closes today, nods at tomorrow.' },
  { id: 'coach-weekly', enabled: true, schedule: '0 19 * * 0', channel: 'telegram', description: 'Sunday week-in-review — trends over time.' },
];

async function ensureAgents() {
  for (const a of DEFAULT_AGENTS) {
    await col('agents').updateOne({ id: a.id }, { $setOnInsert: a }, { upsert: true });
  }
}

export async function scheduleAgents() {
  await ensureAgents();
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
        // Fan out: every active user gets their own check-in, in their own context, so the
        // message is built from THEIR data and delivered to THEIR chat. One person's
        // failure doesn't stop the rest.
        const active = (await users.listUsers()).filter((u) => users.isAllowed(u));
        for (const u of active) {
          try {
            await runAs(u, () => runner());
          } catch (err) {
            console.error(`[runtime] "${agent.id}" failed for ${u._id}:`, err.message);
          }
        }
        await col('agents').updateOne({ id: agent.id }, { $set: { lastRun: new Date() } });
      },
      { timezone: config.timezone }
    );

    console.log(`[runtime] scheduled "${agent.id}" @ "${agent.schedule}"`);
  }
}
