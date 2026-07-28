import * as water from './agents/water.js';
import * as bookCoach from './agents/bookCoach.js';
import * as english from './agents/english.js';
import * as body from './agents/body.js';
import * as reading from './agents/reading.js';
import * as routine from './agents/routine.js';
import * as coach from './coach.js';
import * as system from './system.js';
import { send, sendKeyboard } from './telegram.js';
import * as users from './users.js';

// Slash-commands are quick shortcuts. Everything else goes to the coach.
const shortcuts = [water, bookCoach, body, reading, routine];

// The tap keyboard: labeled buttons → commands, so he never types a command again.
// Translated BEFORE English mode so the buttons keep working mid-conversation.
export const KEYBOARD = [
  ['📊 Status', '📖 Review', '🪞 Portrait'],
  ['🎧 English', '🏁 Done', '❓ Help'],
];
const LABELS = {
  '📊 Status': '/status',
  '📖 Review': '/review',
  '🪞 Portrait': '/portrait',
  '🎧 English': '/english',
  '🏁 Done': '/done',
  '❓ Help': '/help',
};

export async function route({ chatId, from, text, image }) {
  // The door. Every message is attributed to a user record first; the owner is always let
  // in, and while MULTI_TENANT is off nobody else is — they're recorded as pending so they
  // can be approved later, never silently processed into someone else's data.
  const user = await users.ensureUser({
    chatId,
    name: [from?.first_name, from?.last_name].filter(Boolean).join(' '),
    username: from?.username || '',
  });
  if (!users.isAllowed(user)) {
    console.warn(`[router] ignoring message from ${user.status} user ${chatId}`);
    return;
  }
  // A runaway loop or a spammer can't burn the API budget or drown the bot.
  if (!users.rateLimit(user._id)) {
    console.warn(`[router] rate limited ${user._id}`);
    return;
  }

  // Tapped keyboard buttons arrive as their label text — translate to the command.
  if (LABELS[text]) text = LABELS[text];

  if (image) {
    await coach.handle(text || '', image); // a photo — let the coach see and respond
    return;
  }

  // English tutor commands (/english, /done, /englishreport, /library, /deck, /book).
  if (text.startsWith('/') && (await english.command(text))) return;

  // While in English mode, plain text is a conversation with the tutor. Slash-commands
  // still fall through to the normal handlers below (so /status etc. keep working).
  if (!text.startsWith('/') && (await english.isActive())) {
    await english.handle(text);
    return;
  }

  if (/^\/(start|help)\b/i.test(text)) {
    await sendKeyboard(
      '*Personal OS* 🧠\n\n' +
        'Just *talk* to me — sleep, water, food, training, reading, work, mood, even a photo — ' +
        "and I'll log it and coach you.\n\n" +
        '👇 *Your buttons are below the keyboard* — tap, don\'t type. ' +
        'The 📎 *Menu* button opens your app (deck, journal, body, routine, dashboard).\n\n' +
        'Everything, for reference:\n\n' +
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
        '🎧 *English → C2*\n' +
        '`/english` — talk with your tutor (scored, honest)\n' +
        '`/done` — leave English mode\n' +
        '`/englishreport` — your honest trend over time\n' +
        '`/library` — books you\'ve read + how well you got them\n' +
        '`/deck` — open your study deck\n\n' +
        '🧍 *Body*\n' +
        '`/body` — open your body map (log what hurts, then talk it through)\n\n' +
        '📚 *Reading*\n' +
        '`/reading` — your reading journal (books, stats, thoughts)\n\n' +
        '✅ *Routine*\n' +
        '`/routine` — today\'s 3, your daily rhythm, defaults\n\n' +
        '`/help` — show this list',
      KEYBOARD,
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

  // ---- owner-only tenant admin ----
  if (user.role === 'owner' && /^\/users\b/i.test(text)) {
    const rows = await users.listUsers();
    const out = rows.map((u) => {
      const who = u.name || u.username || u._id;
      return `${u.status === 'active' ? '✅' : u.status === 'blocked' ? '⛔' : '⏳'} ${who} · ${u.tier} · id ${u._id}`;
    });
    await send('```\n⟦  U S E R S  ⟧\n' + (out.join('\n') || 'nobody yet') + '\n\n/approve <id> · /block <id>\n```');
    return;
  }
  if (user.role === 'owner') {
    let m = text.match(/^\/approve\s+(\d+)(?:\s+(\w+))?/i);
    if (m) {
      await users.approve(m[1], m[2] || 'trial');
      await send(`✅ Approved \`${m[1]}\` on the *${m[2] || 'trial'}* tier.`);
      return;
    }
    m = text.match(/^\/block\s+(\d+)/i);
    if (m) {
      await users.block(m[1]);
      await send(`⛔ Blocked \`${m[1]}\`.`);
      return;
    }
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
