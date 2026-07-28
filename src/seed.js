import { connect, col } from './db.js';
import * as users from './users.js';
import { runAs } from './ctx.js';
import { config } from './config.js';

async function main() {
  await connect();
  // Seeding writes user data, so it runs as the owner.
  const owner = await users.ensureUser({ chatId: config.telegramChatId, name: 'Гриша' });
  await runAs(owner, seed);
}

async function seed() {
  // --- shared memory: the single document the coach reads ---
  await col('profile').updateOne(
    { _id: 'me' },
    {
      $set: {
        name: 'Гриша',
        location: 'Donegal, Ireland',
        interests: [
          'East Slavic medieval history',
          'financial analysis',
          'investing',
          'systems thinking',
          'web development',
        ],
        goals: [
          'become the kind of top professional companies hunt to hire — grow knowledge and judgment to that level',
          'build SILKILINEN and grow it into an agency',
          'stay sharp, intentional, and deliberate',
          'read with purpose and reflect through writing',
          'build steadier daily habits (sleep, water, focus)',
        ],
        readingTaste:
          'substantive non-fiction; history, finance and the philosophy of risk ' +
          '(Taleb, Marks, Housel); enjoys multi-perspective analysis over convenient narratives',
        notes:
          'Communicates directly, values honest pushback over flattery, working on not being a people-pleaser. ' +
          'Wants to act because he wants to — not because he feels pushed.',
      },
    },
    { upsert: true }
  );

  // --- agent registry: the coach's proactive check-ins ---
  const agents = [
    {
      id: 'coach-morning',
      enabled: true,
      schedule: '0 8 * * *', // every day 08:00
      channel: 'telegram',
      description: 'Morning coach check-in — opens the day based on his data and goals.',
    },
    {
      id: 'coach-evening',
      enabled: true,
      schedule: '0 21 * * *', // every day 21:00
      channel: 'telegram',
      description: 'Evening coach check-in — closes today, nods at tomorrow.',
    },
    {
      id: 'coach-weekly',
      enabled: true,
      schedule: '0 19 * * 0', // Sunday 19:00
      channel: 'telegram',
      description: 'Sunday week-in-review — trends over time.',
    },
  ];
  for (const a of agents) {
    await col('agents').updateOne({ id: a.id }, { $set: a }, { upsert: true });
  }

  // Retire the old single-purpose scheduled agents (their commands still work on demand).
  await col('agents').deleteMany({ id: { $in: ['water', 'book-coach'] } });

  // Initialize the System state once (do not overwrite existing progress).
  await col('system').updateOne(
    { _id: 'state' },
    {
      $setOnInsert: {
        level: 1,
        xp: 0,
        stats: { vitality: 0, mind: 0, forge: 0, discipline: 0, spirit: 0 },
        streak: 0,
        questDate: null,
        quests: {},
        lastClearDate: null,
        titles: [],
      },
    },
    { upsert: true }
  );

  console.log('Seeded profile + coach check-ins + System.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
