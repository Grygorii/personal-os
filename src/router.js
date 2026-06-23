import * as water from './agents/water.js';
import * as bookCoach from './agents/bookCoach.js';
import * as coach from './coach.js';
import * as system from './system.js';
import { send } from './telegram.js';

// Slash-commands are quick shortcuts. Everything else goes to the coach.
const shortcuts = [water, bookCoach];

export async function route({ chatId, text, image }) {
  if (image) {
    await coach.handle(text || '', image); // a photo — let the coach see and respond
    return;
  }
  if (/^\/(start|help)\b/i.test(text)) {
    await send(
      '*Personal OS* 🧠\n\n' +
        'Just *talk* to me — sleep, water, food, training, reading, work, mood, even a photo — ' +
        "and I'll log it and coach you. These commands are quick shortcuts:\n\n" +
        '📊 *View*\n' +
        "`/status` — level, energy, stats, ranks, today's quests\n" +
        '`/ranks` — the rank ladder (Novice → Sage)\n' +
        '`/pursuits` — your personal mastery paths\n' +
        '`/review` — your week in review\n' +
        '`/portrait` — an honest portrait of you (re-read monthly to see change)\n\n' +
        '⚡ *Quick log*\n' +
        '`/water 0.5` — log water\n' +
        '`/read <title>` — start a book\n' +
        '`/progress <note>` — reading progress\n' +
        '`/finished` — finish the current book\n' +
        '`/suggest` — get a book suggestion\n\n' +
        '`/help` — show this list',
      chatId
    );
    return;
  }

  if (/^\/status\b/i.test(text)) {
    await send('```\n' + (await system.statusWindow()) + '\n```');
    return;
  }

  if (/^\/ranks?\b/i.test(text)) {
    const st = await system.currentState();
    await send('```\n' + system.renderLadder(st.level) + '\n```');
    return;
  }

  if (/^\/pursuits?\b/i.test(text)) {
    await send('```\n' + (await coach.listPursuits()) + '\n```');
    return;
  }

  if (/^\/review\b/i.test(text)) {
    await coach.weeklyReview(); // on-demand week-in-review (also saves a snapshot)
    return;
  }

  if (/^\/portrait\b/i.test(text)) {
    await coach.portrait(); // honest, all-directions portrait from real observation (saved over time)
    return;
  }

  // Explicit slash shortcuts (fast path)
  if (text.startsWith('/')) {
    for (const h of shortcuts) {
      if (h.command && (await h.command(text))) return;
    }
    // Unknown command → let the coach handle it as plain talk.
  }

  // Everything else → the coach.
  await coach.handle(text);
}
