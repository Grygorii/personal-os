import * as water from './agents/water.js';
import * as bookCoach from './agents/bookCoach.js';
import * as english from './agents/english.js';
import * as body from './agents/body.js';
import * as reading from './agents/reading.js';
import * as routine from './agents/routine.js';
import * as coach from './coach.js';
import * as system from './system.js';
import { send, sendKeyboard, sendInline, answerCallback, deleteMessage, sendDocument } from './telegram.js';
import * as users from './users.js';
import { maskKey } from './crypto.js';
import { runAs } from './ctx.js';
import { config } from './config.js';
import { runBackup } from './runtime.js';

// Slash-commands are quick shortcuts. Everything else goes to the coach.
const shortcuts = [water, bookCoach, body, reading, routine];

// Always-visible quick actions under the input box.
export const KEYBOARD = [
  ['📊 Status', '🎧 English', '☰ Menu'],
];
const LABELS = {
  '📊 Status': '/status',
  '🎧 English': '/english',
  '☰ Menu': '/menu',
  // kept so older keyboards still work
  '📖 Review': '/review',
  '🪞 Portrait': '/portrait',
  '🏁 Done': '/done',
  '❓ Help': '/menu',
};

const APP = config.appUrl;

// The main menu: everything reachable in one tap. Nothing here needs to be remembered
// or typed — a button exists for each thing, and it does what it says.
const MENU = [
  [{ text: '📊 Status', data: '/status' }, { text: '🎡 Dashboard', url: `${APP}/dashboard` }],
  [{ text: '📖 Week review', data: '/review' }, { text: '🪞 My portrait', data: '/portrait' }],
  [{ text: '🎯 Pursuits', data: '/pursuits' }, { text: '🏅 Ranks', data: '/ranks' }],
  [{ text: '🎧 Talk in English', data: '/english' }, { text: '🏁 Stop English', data: '/done' }],
  [{ text: '📚 Reading', url: `${APP}/reading` }, { text: '📖 Study deck', url: `${APP}/deck` }],
  [{ text: '🧍 Body map', url: `${APP}/body` }, { text: '✅ Routine', url: `${APP}/routine` }],
  [{ text: '⚙️ Settings', data: '/settings' }],
];

// The BOOK PRODUCT surface. Everything else we built still exists in the code — it's
// simply not shown. One promise, one loop: read it, prove you kept it, share it.
export const BOOKS_KEYBOARD = [['📚 My books', '🎓 Exam', '☰ Menu']];
const BOOKS_LABELS = { '📚 My books': '/reading', '🎓 Exam': '/exam', '☰ Menu': '/menu' };

const BOOKS_MENU = [
  [{ text: '📚 My library', url: `${config.appUrl}/reading` }],
  [{ text: '🎓 Test me on a book', url: `${config.appUrl}/reading` }],
  [{ text: '💡 What should I read next?', data: '/suggest' }],
  [{ text: '⚙️ Settings', data: '/settings' }],
];

const SETTINGS = [
  [{ text: '🔑 My AI key', data: '/mykey' }],
  [{ text: '🕒 Timezone', data: '/timezone' }],
  [{ text: '📦 Export my data', data: '/export' }],
  [{ text: '🗑 Delete everything', data: '/delete-me' }],
  [{ text: '‹ Back to menu', data: '/menu' }],
];

const COMMON_TZ = [
  ['Europe/Dublin', 'Europe/London'],
  ['Europe/Lisbon', 'Europe/Warsaw'],
  ['Europe/Kyiv', 'America/New_York'],
];

// The door: identify the sender, check the allowlist and rate limit, then run everything
// else INSIDE that user's context so every read and write is automatically theirs.
export async function route({ chatId, from, text, image, messageId, callbackId }) {
  const user = await users.ensureUser({
    chatId,
    name: [from?.first_name, from?.last_name].filter(Boolean).join(' '),
    username: from?.username || '',
  });
  if (!users.isAllowed(user)) {
    console.warn(`[router] ignoring message from ${user.status} user ${chatId}`);
    // Tell someone waiting exactly once — silence is confusing, repetition is a spam surface.
    if (user.status === 'pending' && !user.notifiedPending) {
      await users.markNotified(chatId);
      await send(
        "👋 Hi — this is a personal mentor bot that's still in a small private beta.\n\n" +
          "You're on the list. If you know Гриша, tell him you knocked and he can let you in.",
        chatId
      );
    }
    return;
  }
  // A runaway loop or a spammer can't burn the API budget or drown the bot.
  if (!users.rateLimit(user._id)) {
    console.warn(`[router] rate limited ${user._id}`);
    return;
  }
  return runAs(user, () => handle({ chatId, text, image, user, messageId, callbackId }));
}

async function handle({ chatId, text, image, user, messageId, callbackId }) {
  // A tapped inline button: stop its spinner immediately, then treat its data as the command.
  if (callbackId) await answerCallback(callbackId);
  const booksOnly = user.product === 'books';
  const KB = booksOnly ? BOOKS_KEYBOARD : KEYBOARD;
  // Tapped keyboard buttons arrive as their label text — translate to the command.
  if (BOOKS_LABELS[text] && booksOnly) text = BOOKS_LABELS[text];
  else if (LABELS[text]) text = LABELS[text];

  // First real contact for a newly approved person: introduce the mentor and let it start
  // building their profile, rather than dropping them into a command list.
  if (!user.onboardedAt && user.role !== 'owner') {
    await users.markOnboarded(chatId);
    if (booksOnly) {
      // One promise, said plainly.
      await sendKeyboard(
        "📕 *You forget most of what you read.*\n\nI fix that.\n\n" +
          "Tell me what you're reading. Send me the thoughts it sparks as you go. " +
          "When you finish, I'll examine you on it — honestly — and you'll know whether you actually kept it.",
        BOOKS_KEYBOARD,
        chatId
      );
      await sendInline('Start with the book in your hands:', [
        [{ text: '📚 Open my library', url: `${config.appUrl}/reading` }],
        [{ text: '💡 Suggest me something', data: '/suggest' }],
      ], chatId);
      return;
    }
    await sendKeyboard(
      "👋 *Welcome.* I'm your mentor — not a tracker or a chatbot.\n\n" +
        "Two things I do: get to know you properly, then help you move — a little better, every day. " +
        "Just talk to me like a person: how you slept, what you're working on, what's on your mind. " +
        "I'll remember, notice patterns, and push you where it counts.\n\n" +
        'Your buttons are below. `/help` any time · `/mykey` to use your own AI key · ' +
        '`/timezone Europe/Lisbon` so I reach you at the right hour.',
      KEYBOARD,
      chatId
    );
    // Hand straight to the mentor so its first question opens the interview.
    await coach.handle(
      text && !text.startsWith('/')
        ? text
        : "(This is our very first exchange. Introduce yourself briefly and ask ONE opening question that starts building your picture of who they are.)"
    );
    return;
  }

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

  if (/^\/start\b/i.test(text)) {
    await sendKeyboard(
      booksOnly
        ? "📕 Tell me what you're reading, and the thoughts it sparks. When you finish, I'll test whether you kept it."
        : '*Personal OS* 🧠\n\nJust talk to me — sleep, water, training, reading, work, mood, ' +
            'even a photo. I listen, remember, and coach.\n\nTap *☰ Menu* below for everything else.',
      KB,
      chatId
    );
    await sendInline(booksOnly ? 'Where to?' : 'What do you want to open?', booksOnly ? BOOKS_MENU : MENU, chatId);
    return;
  }

  if (/^\/(menu|help)\b/i.test(text)) {
    await sendInline(
      booksOnly
        ? "☰ *Menu*\n\n_Just talk to me about what you're reading — no commands needed._"
        : '☰ *Menu* — tap anything.\n\n_You never need to type a command. To log something, just say it in your own words._',
      booksOnly ? BOOKS_MENU : MENU,
      chatId
    );
    return;
  }

  // In the book product, everything outside the reading loop simply isn't there.
  if (booksOnly && /^\/(status|ranks?|pursuits?|review|portrait|english|done|englishreport|library|deck|body|routine|water)\b/i.test(text)) {
    await sendInline("That's not part of this — I keep to books.", BOOKS_MENU, chatId);
    return;
  }

  if (/^\/settings\b/i.test(text)) {
    const rows = [...SETTINGS];
    if (user.role === 'owner') {
      rows.splice(rows.length - 1, 0, [
        { text: '👥 Users', data: '/users' },
        { text: '🗄 Backup now', data: '/backup' },
      ]);
      rows.splice(rows.length - 1, 0, [
        { text: user.product === 'books' ? '🧠 Back to full OS' : '📕 Preview book product', data: '/preview' },
      ]);
    }
    await sendInline(
      `⚙️ *Settings*\n\nAI: ${user.llm?.hint ? `your own *${user.llm.provider}* key` : 'shared'} · Timezone: \`${user.tz}\``,
      rows,
      chatId
    );
    return;
  }

  if (/^\/status\b/i.test(text)) {
    await sendInline('```\n' + (await system.statusWindow()) + '\n```', [
      [{ text: '🎡 Dashboard', url: `${APP}/dashboard` }, { text: '🏅 Ranks', data: '/ranks' }],
      [{ text: '🎯 Pursuits', data: '/pursuits' }, { text: '☰ Menu', data: '/menu' }],
    ], chatId);
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

  if (/^\/exam\b/i.test(text)) {
    await sendInline(
      '🎓 *Test yourself on a book*\n\nOpen your library, pick the book, and tap *Test my knowledge*. ' +
        "Five questions, graded honestly — bluffing scores low.",
      [[{ text: '📚 Open my library', url: `${config.appUrl}/reading` }]],
      chatId
    );
    return;
  }

  // Owner preview: see exactly what a reader sees, and switch back.
  if (user.role === 'owner' && /^\/preview\b/i.test(text)) {
    const to = user.product === 'books' ? 'full' : 'books';
    await users.setProduct(chatId, to);
    await sendKeyboard(
      to === 'books'
        ? '📕 *Book product view.* This is what a new reader gets — everything else is hidden.\nTap 📕 again (`/preview`) to return to your full OS.'
        : '🧠 *Full OS view* restored.',
      to === 'books' ? BOOKS_KEYBOARD : KEYBOARD,
      chatId
    );
    await sendInline('Menu:', to === 'books' ? BOOKS_MENU : MENU, chatId);
    return;
  }

  // ---- your own AI key, your timezone, your data ----
  if (/^\/mykey\b/i.test(text)) {
    const arg = text.replace(/^\/mykey\s*/i, '').trim();
    if (!arg || /^status$/i.test(arg)) {
      const rows = user.llm?.hint
        ? [[{ text: '🗑 Remove my key', data: '/mykey remove' }], [{ text: '‹ Settings', data: '/settings' }]]
        : [
            [{ text: '🔗 Get a free Gemini key', url: 'https://aistudio.google.com/apikey' }],
            [{ text: '‹ Settings', data: '/settings' }],
          ];
      await sendInline(
        user.llm?.hint
          ? `🔑 You're using your own *${user.llm.provider}* key (\`${user.llm.hint}\`).`
          : "🔑 You're on the shared AI.\n\nWant your own? It's free and takes a minute:\n" +
              '1️⃣ Tap below to get a Gemini key (no card needed)\n' +
              '2️⃣ Send it here as: `/mykey gemini YOUR_KEY`\n\n' +
              "_I delete your message the instant I read it, and encrypt the key before storing it._",
        rows,
        chatId
      );
      return;
    }
    if (/^remove$/i.test(arg)) {
      await users.clearUserKey(chatId);
      await send('🔑 Removed. You\'re back on the shared AI.', chatId);
      return;
    }
    const m = arg.match(/^(gemini|anthropic)\s+(\S+)$/i);
    if (!m) {
      await send('Use: `/mykey gemini YOUR_KEY` or `/mykey anthropic YOUR_KEY`', chatId);
      return;
    }
    // Delete the message with the secret in it before anything else.
    await deleteMessage(messageId, chatId);
    try {
      await users.setUserKey(chatId, m[1].toLowerCase(), m[2]);
      await send(`🔑 Saved your *${m[1].toLowerCase()}* key (\`${maskKey(m[2])}\`) — encrypted, and I removed your message.`, chatId);
    } catch (e) {
      await send(`Couldn't save that key: ${e.message}`, chatId);
    }
    return;
  }

  if (/^\/timezone\b/i.test(text)) {
    const tz = text.replace(/^\/timezone\s*/i, '').trim();
    if (!tz) {
      const now = users.localNow(user.tz);
      await sendInline(
        `🕒 Your timezone is \`${user.tz}\` — it's ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')} for you.\n\n` +
          'Tap yours, or type `/timezone Asia/Tokyo` for any other.',
        [...COMMON_TZ.map((row) => row.map((z) => ({ text: z.split('/')[1].replace('_', ' '), data: `/timezone ${z}` }))), [{ text: '‹ Settings', data: '/settings' }]],
        chatId
      );
      return;
    }
    if (!users.validTimezone(tz)) {
      await send('That timezone isn\'t recognised. Use a name like `Europe/Dublin` or `America/New_York`.', chatId);
      return;
    }
    await users.setTimezone(chatId, tz);
    const now = users.localNow(tz);
    await send(`🕒 Set to \`${tz}\` — it's ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')} for you. Check-ins will follow your clock.`, chatId);
    return;
  }

  if (/^\/export\b/i.test(text)) {
    await send('📦 Packing up everything I hold about you…', chatId);
    const data = await users.exportUserData(user._id);
    const counts = Object.entries(data.collections).map(([k, v]) => `${k} ${v.length}`).join(' · ');
    await sendDocument(
      `personal-os-export-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(data, null, 2),
      `Everything I hold about you.\n${counts || 'no records yet'}`,
      chatId
    );
    return;
  }

  if (/^\/delete-?me\b/i.test(text)) {
    if (/confirm/i.test(text)) {
      const removed = await users.deleteUserData(user._id, { keepAccount: user.role === 'owner' });
      const summary = Object.entries(removed).map(([k, v]) => `${k} ${v}`).join(' · ') || 'nothing stored';
      await send(`🗑 Deleted: ${summary}.\n\nEverything of yours is gone. Goodbye — and good luck. 🫡`, chatId);
      return;
    }
    await sendInline(
      '⚠️ *This erases everything* — your profile, your System, every log, book, exam and conversation. ' +
        'It cannot be undone.',
      [
        [{ text: '📦 Export first', data: '/export' }],
        [{ text: '🗑 Yes, delete everything', data: '/delete-me confirm' }],
        [{ text: '‹ Cancel', data: '/settings' }],
      ],
      chatId
    );
    return;
  }

  // ---- owner-only tenant admin ----
  if (user.role === 'owner' && /^\/backup\b/i.test(text)) {
    await send('🗄 Taking a backup…', chatId);
    await runBackup();
    return;
  }
  if (user.role === 'owner' && /^\/users\b/i.test(text)) {
    const arg = text.replace(/^\/users\s*/i, '').trim();
    const [status, pageStr] = arg.split(/\s+/);
    // The overview: how many are waiting, in, or out — each a button into that queue.
    if (!status) {
      const n = await users.countByStatus();
      await sendInline(
        `👥 *Users*\n\n⏳ ${n.pending} waiting · ✅ ${n.active} active · ⛔ ${n.blocked} blocked`,
        [
          [{ text: `⏳ Review waiting (${n.pending})`, data: '/users pending' }],
          [{ text: `✅ Active (${n.active})`, data: '/users active' }, { text: `⛔ Blocked (${n.blocked})`, data: '/users blocked' }],
          [{ text: '‹ Settings', data: '/settings' }],
        ],
        chatId
      );
      return;
    }
    // One page of a queue, each person with their own action buttons — so approving is a
    // tap, and the list stays readable at any scale.
    const PER = 5;
    const page = Math.max(0, parseInt(pageStr, 10) || 0);
    const { rows, total } = await users.listByStatus(status, { skip: page * PER, limit: PER });
    const icon = status === 'active' ? '✅' : status === 'blocked' ? '⛔' : '⏳';
    if (!rows.length) {
      await sendInline(`${icon} Nobody ${status}.`, [[{ text: '‹ Users', data: '/users' }]], chatId);
      return;
    }
    const buttons = rows.map((u) => {
      const who = (u.name || u.username || u._id).slice(0, 18);
      return status === 'active'
        ? [{ text: `⛔ Block ${who}`, data: `/block ${u._id}` }]
        : [{ text: `✅ Approve ${who}`, data: `/approve ${u._id}` }, { text: '⛔', data: `/block ${u._id}` }];
    });
    const nav = [];
    if (page > 0) nav.push({ text: '‹ Prev', data: `/users ${status} ${page - 1}` });
    if ((page + 1) * PER < total) nav.push({ text: 'Next ›', data: `/users ${status} ${page + 1}` });
    if (nav.length) buttons.push(nav);
    buttons.push([{ text: '‹ Users', data: '/users' }]);
    const lines = rows.map((u) => `${icon} ${u.name || u.username || u._id}${u.username ? ` (@${u.username})` : ''} · ${u.tier}`);
    const from = page * PER + 1;
    await sendInline(
      `*${status}* — showing ${from}–${from + rows.length - 1} of ${total}\n\n${lines.join('\n')}`,
      buttons,
      chatId
    );
    return;
  }
  if (user.role === 'owner') {
    let m = text.match(/^\/approve\s+(\d+)(?:\s+(\w+))?/i);
    if (m) {
      const [, id, tier = 'trial'] = m;
      await users.approve(id, tier);
      // Tell them they're in — otherwise they'd never know until they happened to write again.
      await send(
        "🎉 You're in.\n\nSay hello whenever you're ready — I'll take it from there.",
        id
      );
      await sendInline(`✅ Approved *${id}* on the *${tier}* tier — they've been told.`, [
        [{ text: '⏳ Next waiting', data: '/users pending' }],
        [{ text: '‹ Users', data: '/users' }],
      ], chatId);
      return;
    }
    m = text.match(/^\/block\s+(\d+)/i);
    if (m) {
      await users.block(m[1]);
      await sendInline(`⛔ Blocked *${m[1]}*.`, [
        [{ text: '⏳ Waiting list', data: '/users pending' }],
        [{ text: '‹ Users', data: '/users' }],
      ], chatId);
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
