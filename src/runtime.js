import cron from 'node-cron';
import { col } from './db.js';
import { config } from './config.js';
import { sendDocument } from './telegram.js';
import * as coach from './coach.js';
import * as users from './users.js';
import { runAs, currentUser } from './ctx.js';
import * as push from './push.js';

// Map agent id -> scheduled handler. The coach owns the proactive pulse;
// water/book commands still work on demand via the router (no schedule needed).
const runners = {
  // Per-user, in their own timezone, once a day, with alreadyRan() making a double send
  // impossible even if the process restarts mid-tick. Nothing here needed building — the
  // scheduler has run the coach's check-ins this way for months.
  'daily-thought': () => push.dailyThought(currentUser()),
  'coach-morning': () => coach.checkIn('morning'),
  'coach-evening': () => coach.checkIn('evening'),
  'coach-weekly': () => coach.weeklyReview(),
  backup: () => runBackup(),
};

// Atlas's free tier has no backups, so we make our own: every user's full record, dumped
// to JSON and delivered to the owner as a file. Costs nothing, and it's a real recovery
// path — the export format is the same one /export produces.
export async function runBackup() {
  const all = await users.listUsers();
  const dump = { takenAt: new Date().toISOString(), users: [] };
  for (const u of all) dump.users.push(await users.exportUserData(u._id));
  const json = JSON.stringify(dump);
  const rows = dump.users.reduce((n, u) => n + Object.values(u.collections).reduce((m, c) => m + c.length, 0), 0);
  await sendDocument(
    `personal-os-backup-${new Date().toISOString().slice(0, 10)}.json`,
    json,
    `🗄 Weekly backup — ${all.length} user(s), ${rows} records, ${(json.length / 1024).toFixed(0)} KB.\nKeep this message; it's your restore point.`,
    config.telegramChatId
  );
  console.log(`[backup] ${all.length} users, ${rows} records`);
}

// Canonical agents, upserted on boot so new ones register on deploy without a
// manual re-seed. $setOnInsert means existing rows (and any custom schedules) are left alone.
const DEFAULT_AGENTS = [
  { id: 'coach-morning', enabled: true, schedule: '0 8 * * *', channel: 'telegram', description: 'Morning check-in — opens the day.' },
  { id: 'coach-evening', enabled: true, schedule: '0 21 * * *', channel: 'telegram', description: 'Evening check-in — closes today, nods at tomorrow.' },
  { id: 'coach-weekly', enabled: true, schedule: '0 19 * * 0', channel: 'telegram', description: 'Sunday week-in-review — trends over time.' },
  { id: 'backup', enabled: true, schedule: '30 3 * * 1', ownerOnly: true, channel: 'telegram', description: 'Weekly backup of every user, delivered to the owner.' },
  // 9am local: after waking, before the day takes over. One a day, never two.
  { id: 'daily-thought', enabled: true, schedule: '0 9 * * *', channel: 'push', description: 'One thought you kept, handed back.' },
];

async function ensureAgents() {
  for (const a of DEFAULT_AGENTS) {
    await col('agents').updateOne({ id: a.id }, { $setOnInsert: a }, { upsert: true });
  }
}

// Does a "minute hour * * dow" schedule match this local moment? Supports the forms the
// app uses: a number, a comma list, or '*'. Anything else is rejected loudly.
export function scheduleMatches(schedule, { hour, minute, dow }) {
  const parts = String(schedule || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const field = (spec, value) =>
    spec === '*' || spec.split(',').some((s) => /^\d+$/.test(s) && Number(s) === value);
  const [min, hr, , , wd] = parts;
  return field(min, minute) && field(hr, hour) && (wd === '*' || field(wd, dow % 7));
}

// One tick a minute drives everyone. Each active user is evaluated against each agent in
// THEIR timezone, so a tenant in Lisbon gets their morning check-in at their 8am — not the
// owner's. A per-user, per-day marker makes a run happen exactly once.
export async function scheduleAgents() {
  await ensureAgents();
  const agents = (await col('agents').find({ enabled: true }).toArray()).filter((a) => {
    if (!runners[a.id]) {
      console.warn(`[runtime] no runner registered for agent "${a.id}"`);
      return false;
    }
    if (!cron.validate(a.schedule)) {
      console.warn(`[runtime] invalid cron for "${a.id}": ${a.schedule}`);
      return false;
    }
    return true;
  });

  for (const a of agents) console.log(`[runtime] agent "${a.id}" @ "${a.schedule}" (per-user local time)`);

  cron.schedule('* * * * *', async () => {
    let active;
    try {
      active = (await users.listUsers()).filter((u) => users.isAllowed(u));
    } catch (err) {
      console.error('[runtime] tick could not load users:', err.message);
      return;
    }
    for (const u of active) {
      const now = users.localNow(u.tz);
      for (const agent of agents) {
        if (agent.ownerOnly && u.role !== 'owner') continue; // e.g. the backup runs once
        if (!scheduleMatches(agent.schedule, now)) continue;
        if (users.alreadyRan(u, agent.id, now.date)) continue;
        try {
          // Mark first: a crash mid-run must not cause a retry loop every minute.
          await users.recordRun(u._id, agent.id, now.date);
          console.log(`[runtime] "${agent.id}" for ${u._id} (${u.tz})`);
          await runAs(u, () => runners[agent.id]());
        } catch (err) {
          console.error(`[runtime] "${agent.id}" failed for ${u._id}:`, err.message);
        }
      }
    }
  });
}
