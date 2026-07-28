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
  // Tapped keyboard buttons arrive as their label text — translate to the command.
  if (LABELS[text]) text = LABELS[text];

  // First real contact for a newly approved person: introduce the mentor and let it start
  // building their profile, rather than dropping them into a command list.
  if (!user.onboardedAt && user.role !== 'owner') {
    await users.markOnboarded(chatId);
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
      '*Personal OS* 🧠\n\nJust talk to me — sleep, water, training, reading, work, mood, ' +
        'even a photo. I listen, remember, and coach.\n\nTap *☰ Menu* below for everything else.',
      KEYBOARD,
      chatId
    );
    await sendInline('What do you want to open?', MENU, chatId);
    return;
  }

  if (/^\/(menu|help)\b/i.test(text)) {
    await sendInline(
      '☰ *Menu* — tap anything.\n\n_You never need to type a command. To log something, just say it in your own words._',
      MENU,
      chatId
    );
    return;
  }

  if (/^\/settings\b/i.test(text)) {
    await sendInline(
      `⚙️ *Settings*\n\nAI: ${user.llm?.hint ? `your own *${user.llm.provider}* key` : 'shared'} · Timezone: \`${user.tz}\``,
      SETTINGS,
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
