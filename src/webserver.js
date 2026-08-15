import http from 'http';
import crypto from 'crypto';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { col, rawCol, getProfile, logEvent, dbStats } from './db.js';
import { config } from './config.js';
import { chat } from './llm.js';
import { reflow, looksWrapped } from './text.js';
import { sendPings, send as sendTelegram } from './telegram.js';
import * as system from './system.js';
import * as users from './users.js';
import * as coach from './coach.js';
import * as moderation from './moderation.js';
import { runAs, uid, personName, languageRule } from './ctx.js';
import { verifyTelegramLogin, verifyGoogleToken, createSession, readSession, parseCookies, sessionCookie, clearedCookie, refCookie, clearedRefCookie, mailCookie } from './auth.js';
import * as contact from './contact.js';
import { addBook } from './library.js';

// Read a small JSON request body (exam answers etc.). Hard cap, raised only for the one
// endpoint that carries a photograph — the client downscales first, so this is a ceiling
// against abuse rather than a size anyone should reach.
function readJson(req, cap = 200000) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > cap) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// A stable handle for someone with no account, for rate limiting only.
//
// It is hashed, and salted with a value that dies with the process, so it cannot be turned
// back into an address, cannot be matched against a log, and cannot survive a restart. The
// privacy page says we don't keep IP addresses; this is how that stays true while still
// making it impossible for one stranger to send ten thousand messages. Nothing here is ever
// written to the database.
//
// Railway terminates TLS in front of us, so the socket address is the proxy's. The LAST
// entry in x-forwarded-for is the one the closest proxy added; the leftmost is whatever the
// client claimed, which is free to be a lie.
const IP_SALT = crypto.randomBytes(16);
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const raw = fwd.length ? fwd[fwd.length - 1] : req.socket?.remoteAddress || 'unknown';
  return crypto.createHash('sha256').update(IP_SALT).update(raw).digest('hex').slice(0, 16);
}

// Tolerant JSON extraction from a model reply (same pattern as the coach).
function parseModelJson(raw) {
  const clean = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
  try { return JSON.parse(clean); } catch { /* try embedded */ }
  const m = clean.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch { /* no */ }
  return null;
}

// A tiny static server for the Telegram Mini App: serves the home hub and tool pages, plus
// (Phase B) a single authenticated /api/dashboard endpoint that returns his LIVE System data
// from MongoDB. Auth is Telegram initData verified server-side with the bot token — the token
// never leaves the server, and only his own Telegram id is served his own data.

const ROUTES = {
  // '/' is the public front door — what a stranger from a shared link or a search sees.
  // '/app' is the product itself and is handled separately (it needs a session gate), so
  // an installed app never opens onto marketing.
  // `public: true` used to mean nothing but "substitute APP_URL in this file". It READ like
  // an access-control flag, so every page without it looked gated and none of them were:
  // /body, /routine, /deck, /dashboard and /hub were served to anyone who asked. No data
  // leaked — every API behind them 401s and the markup holds nothing personal — but a
  // stranger could walk through the skeleton of a private system, and the next page added
  // here would have inherited the same false sense of safety.
  //
  // Now a route says what it needs, and `needs` is checked before the file is read.
  '/': { file: '../webapp/landing.html', public: true },
  '/privacy': { file: '../webapp/privacy.html', public: true },
  '/hub': { file: '../webapp/home.html', needs: 'system' },
  '/home': { file: '../webapp/home.html', needs: 'system' },
  '/deck': { file: '../english/study.html', homeBar: true, needs: 'english' },
  '/body': { file: '../body/map.html', homeBar: true, needs: 'body' },
  // NOT the journal any more. This route served journal.html raw, so the placeholders the
  // /app handler fills in were shipped as literal text — OWNER_LINK printed on screen and
  // IS_GUEST threw a ReferenceError that killed the whole app script. Anyone still holding
  // an old link or home-screen icon from the Telegram days landed on a dead page.
  '/reading': { redirect: '/app' },
  '/routine': { file: '../routines/today.html', homeBar: true, needs: 'routine' },
  '/dashboard': { file: '../webapp/dashboard.html', needs: 'system' },
};

// iOS ignores SVG for Add to Home Screen, so a site whose only icon is an SVG gets a
// generic thumbnail on the home screen — right after someone decided to trust it enough to
// install. These are real PNGs (see scripts/make-icons.mjs).
const ASSETS = {
  '/me.jpg': { file: 'me.jpg', type: 'image/jpeg' },
  '/icon-180.png': { file: 'icon-180.png', type: 'image/png' },
  '/icon-192.png': { file: 'icon-192.png', type: 'image/png' },
  '/icon-512.png': { file: 'icon-512.png', type: 'image/png' },
  '/og.png': { file: 'og.png', type: 'image/png' },
};

// ---- did anyone actually come? ----
// The admin page can only show people who SIGNED IN, so "nothing is happening" has two very
// different causes — nobody clicked, or people clicked and left at the sign-in screen — and
// they need opposite fixes. This is the smallest thing that can tell them apart: one integer
// per day per page. No cookie, no identifier, no path, nothing about any person; you cannot
// reconstruct a visitor from a counter. Link-preview scrapers are counted separately, so
// "LinkedIn fetched the page but no humans followed" is visible as itself.
const UA_BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|linkedinbot|whatsapp|telegram|slackbot|discord|embed|curl|wget|python-requests|headless/i;
// Tapping a link inside LinkedIn, Facebook or Instagram opens their own embedded browser,
// and Google refuses to run sign-in in one. Counted separately because it is the difference
// between "nobody wanted to sign in" and "nobody was allowed to" — two opposite problems.
const UA_INAPP = /LinkedInApp|FBAN|FBAV|FB_IAB|Instagram|Snapchat|TikTok|Line\/|MicroMessenger|Twitter/i;

function countVisit(page, ua) {
  const day = new Date().toISOString().slice(0, 10);
  const s = String(ua || '');
  const kind = UA_BOT.test(s) ? 'bots' : UA_INAPP.test(s) ? 'inapp' : 'people';
  rawCol('meta')
    .updateOne({ _id: `visits:${day}` }, { $inc: { [`${page}.${kind}`]: 1 } }, { upsert: true })
    .catch(() => {}); // never let counting slow or break a page load
}

// Verify Telegram Mini App initData (https://core.telegram.org/bots/webapps#validating-data).
// Returns the parsed user object if the signature is valid, else null.
const INITDATA_TTL_MS = 24 * 60 * 60 * 1000; // a captured initData must not work forever

export function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const check = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  // Constant-time compare: a plain !== leaks how much of the hash matched via timing.
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  // Freshness: without this, one captured initData string is a permanent credential.
  const authDate = Number(params.get('auth_date')) * 1000;
  if (!authDate || Date.now() - authDate > INITDATA_TTL_MS) return null;
  try {
    return JSON.parse(params.get('user') || '{}');
  } catch {
    return null;
  }
}

// Gather his live System into a compact JSON for the dashboard.
async function gatherDashboard() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [st, en, logs, scores] = await Promise.all([
    system.currentState(),
    system.energySnapshot(),
    col('logs').find({ ts: { $gte: startOfDay } }).toArray(),
    col('english_scores').find().sort({ ts: 1 }).toArray(),
  ]);
  const qp = system.questProgress(logs);
  const QL = { hydrate: 'Hydrate', move: 'Move', read: 'Learn', build: 'Build' };
  const quests = Object.keys(qp).map((k) => ({ key: k, label: QL[k] || k, met: qp[k].met, text: qp[k].text }));
  const english = scores.length
    ? {
        count: scores.length,
        avg: +(scores.reduce((a, b) => a + (b.avg || 0), 0) / scores.length).toFixed(2),
        level: scores[scores.length - 1].level_estimate || null,
        trend: scores.slice(-12).map((s) => ({ d: new Date(s.ts).toISOString().slice(5, 10), avg: s.avg || null })),
      }
    : { count: 0 };
  return {
    level: st.level, rank: st.rank, stats: st.stats, domainRanks: st.domainRanks,
    streak: st.streak, titles: st.titles || [],
    energy: en.energy, sleep: en.sleepHours, water: en.todayWater,
    debuffs: (en.effects.debuffs || []).map((d) => ({ label: d.label, note: d.note })),
    buffs: (en.effects.buffs || []).map((b) => ({ label: b.label, note: b.note })),
    quests, english,
  };
}

// Personal book recommendations for the Reading journal — generated from his profile,
// goals, and reading history; cached a week so it costs one model call, not one per open.
// Bump whenever the prompt below changes in a way that makes old answers wrong. A cached
// result from an earlier version counts as a miss — otherwise fixing the prompt fixes
// nothing for the people already holding a week-old answer from the broken one.
const RECS_PROMPT_VERSION = 2;

async function gatherBookRecs(refresh) {
  const DAY = 86400000;
  // meta is a global collection, so this cache key must carry the user itself.
  const cacheId = `book_recs:${uid()}`;
  const cached = await col('meta').findOne({ _id: cacheId });
  const fresh =
    cached?.ts &&
    cached.v === RECS_PROMPT_VERSION &&
    Date.now() - new Date(cached.ts).getTime() < 7 * DAY;
  if (cached?.recs?.length && fresh && !refresh) return { recs: cached.recs, at: cached.ts };

  const [profile, bookLogs, engBooks, library, current] = await Promise.all([
    getProfile(),
    col('logs').find({ type: 'book' }).sort({ ts: -1 }).limit(20).toArray(),
    col('english_books').find().sort({ lastDiscussed: -1 }).limit(10).toArray(),
    col('books').findOne({ _id: 'library' }),
    col('reading').findOne({ _id: 'current' }),
  ]);
  // Their actual shelf counts as history too — recommending a book already sitting in the
  // library is the fastest way to look like you don't know them at all.
  const history = [
    ...new Set(
      [
        ...(library?.books || []).map((b) => b.title),
        ...bookLogs.map((b) => b.title),
        ...engBooks.map((b) => b.title),
        current?.title,
      ].filter(Boolean)
    ),
  ];

  // What we genuinely know about THIS reader. This prompt used to be hardcoded to the
  // owner's life — his mission, his shop — so every other reader got recommendations
  // written for somebody else. Nothing here may assume whose account this is.
  const known = {
    mission: profile.mission || null,
    goals: profile.goals || null,
    readingTaste: profile.readingTaste || null,
    interests: profile.interests || null,
  };
  const knowThem = Object.values(known).some(Boolean) || history.length > 0;

  const sys = `${languageRule()}
You are ${personName()}'s reading advisor. Recommend exactly 4 books they have NOT read.

${
  knowThem
    ? `Choose FOR THIS PERSON, from what's below — and spread them out, so at least one lands.
WHAT YOU KNOW ABOUT THEM: ${JSON.stringify(known)}
ALREADY READ OR ON THEIR SHELF (never recommend these): ${history.join('; ') || 'nothing yet'}`
    : `You know nothing about them yet — this is their first day, and four good books are
still more useful than an apology. Pick four that pull in different directions: one on how
minds and habits actually work, one on money, risk or decisions, one piece of narrative
non-fiction or history that reads like a story, and one novel people finish and remember.
Widely loved is right here — a new shelf needs foundations, not deep cuts.`
}

"why" is ONE sharp sentence (max 160 chars): what this reader would get out of it. Never a blurb, never marketing.

Reply with ONLY JSON, no fences: {"recs":[{"title":"...","author":"...","why":"..."}]}`;

  const raw = await chat({ system: sys, messages: [{ role: 'user', content: 'Recommend my next four books.' }], maxTokens: 700 });
  const clean = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
  let recs = null;
  try {
    recs = JSON.parse(clean).recs;
  } catch {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) try { recs = JSON.parse(m[0]).recs; } catch { /* fall through */ }
  }
  if (!Array.isArray(recs) || !recs.length) {
    if (cached?.recs?.length) return { recs: cached.recs, at: cached.ts }; // stale beats broken
    // Answer 200 with nothing rather than 500. A failed model call used to take the whole
    // "Recommended next" panel off the page — including the button to try again.
    return { recs: [], at: null, failed: true };
  }
  recs = recs.slice(0, 4).map((r) => ({ title: String(r.title || ''), author: String(r.author || ''), why: String(r.why || '') }));
  await col('meta').updateOne({ _id: cacheId }, { $set: { ts: new Date(), v: RECS_PROMPT_VERSION, recs } }, { upsert: true });
  return { recs, at: new Date() };
}

// ---- Capturing a thought without typing it ----
// Two ways in, both landing in the same editable box: dictate it (the phone's own keyboard
// mic already does the speech part for free, so all that's missing is tidying the result),
// or photograph the page. Neither is allowed to overwrite what the reader wrote — both hand
// back text for them to accept or change, because a note is theirs and a model guessing at
// a blurry page or an accent must never be the last word.

// Spelling and punctuation only. Explicitly NOT an editor: it must not improve, shorten or
// formalise anyone's thinking, and it must stay in the language they wrote in.
// One ceiling for a thought, named once. Transcription used to hand back up to 4000
// characters while tidy quietly cut its input to 2000 and the app wrote that back over the
// note — so tidying a photographed page deleted everything past the halfway mark. Two
// limits on the same value, set months apart, and the smaller one won in silence.
const NOTE_MAX = 4000;

async function tidyText(raw) {
  const source = String(raw || '').trim().slice(0, NOTE_MAX);
  if (source.length < 2) return { text: source };
  // Undo the page's own wrapping before the model sees it, so its attention goes on spelling
  // rather than re-flowing. Free, certain, and it means a thought already saved looking
  // broken can be repaired with one tap — the only honest way to fix what's already stored,
  // since silently rewriting someone's saved words server-side is not ours to do.
  const text = looksWrapped(source) ? reflow(source) : source;
  const sys = `${languageRule()}
You fix typing, nothing else, in a note ${personName()} jotted while reading.
Correct spelling, grammar and punctuation. Keep their exact words, their voice, their meaning
and their language. Never add an idea, never remove one, never summarise, never make it more
formal, never translate. If it already reads correctly, return it exactly as it is.
Reply with ONLY the corrected note. No preamble, no quotes, no explanation.`;
  // Sized from the note in front of it. A fixed ceiling is how a long reply comes back
  // chopped off mid-sentence, and a chopped reply is indistinguishable from a good one.
  const out = await chat({
    system: sys,
    messages: [{ role: 'user', content: text }],
    maxTokens: Math.min(4000, Math.ceil(text.length / 2) + 400),
  });
  const cleaned = String(out || '').trim().replace(/^["']|["']$/g, '');
  // Guarded in BOTH directions. An essay back means it ignored the brief; a note that lost a
  // third of its words means it summarised or the reply was cut off. Only one of those two
  // failures destroys the reader's writing, and it was the one with no check in front of it.
  const words = (s) => s.split(/\s+/).filter(Boolean).length;
  if (!cleaned || words(cleaned) < words(text) * 0.7 || cleaned.length > text.length * 3 + 80) {
    return { text };   // still reflowed — they keep that much even when the model misbehaves
  }
  return { text: cleaned.slice(0, NOTE_MAX) };
}

// Read a photographed page. Returns the words on it and nothing else — no summary, no
// interpretation, because the reader is going to trim it down to the bit they wanted.
async function readPage(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('not an image');
  const [, mediaType, data] = m;
  if (data.length > 1_400_000) throw new Error('image too large');
  // "Keeping its line breaks" is what this used to ask for, and it was the wrong kind of
  // faithfulness: a printed line break is a fact about the paper's width, not about the
  // sentence. Reproduced in a phone-width column it reads as gibberish with half the words
  // split in two. Faithful to the WORDS, reflowed to wherever they're being read.
  const sys = `${languageRule()}
You transcribe photographs of book pages.
Return ONLY the words visible in the image, with their punctuation, and nothing else.
Join words the printer split across two lines: "de-" then "signed" is the single word
"designed". Run each paragraph together as continuous prose — the line breaks come from the
width of the page, not from the writing — and put a blank line between paragraphs. Keep the
separate lines only where the writing really has them: verse, lists, headings.
If part is cut off or unreadable, leave it out rather than guessing. If the photo contains no
readable text, reply with exactly: NO_TEXT
Never summarise, never comment, never add anything of your own.`;
  const out = await chat({
    system: sys,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
      { type: 'text', text: 'Transcribe this page.' },
    ] }],
    // A ceiling costs nothing until it's reached — you pay for the tokens produced, not the
    // ones allowed. 900 was under a dense page in Cyrillic, and a page that runs over comes
    // back cut off mid-word with no sign that anything is missing.
    maxTokens: 2000,
  });
  const text = String(out || '').trim();
  if (!text || text === 'NO_TEXT') return { text: '', empty: true };
  // The prompt asks for reflowed prose; this makes sure of it. A prompt is a request, a
  // regex is a guarantee, and the reader is the one who sees the difference.
  const flowed = looksWrapped(text) ? reflow(text) : text;
  return { text: flowed.slice(0, NOTE_MAX) };
}

// ---- Looking a book up so nobody has to type it twice ----
// The landing demo has always shown the author appearing on its own when you type a title.
// The app didn't do it — you typed everything by hand, at the exact step where every reader
// so far has stopped. Open Library is free and needs no key.
//
// Proxied through us rather than called from the browser for three reasons: the CSP stays
// at connect-src 'self', the reader's IP never reaches a third party (which is what the
// privacy page promises), and a slow upstream can't hang the page — 6s and we give up.
async function searchBooks(q) {
  const query = String(q || '').trim().slice(0, 120);
  if (query.length < 3) return { results: [] };
  const url =
    'https://openlibrary.org/search.json?limit=6&fields=title,author_name,number_of_pages_median,cover_i,first_publish_year&q=' +
    encodeURIComponent(query);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Kept/1.0 (+https://readkept.com)' } });
    if (!r.ok) return { results: [] };
    const j = await r.json();
    return {
      results: (j.docs || [])
        .map((d) => ({
          title: String(d.title || '').slice(0, 300),
          author: d.author_name?.[0] ? String(d.author_name[0]).slice(0, 200) : '',
          pages: Number(d.number_of_pages_median) || null,
          cover: Number(d.cover_i) || null,
          year: Number(d.first_publish_year) || null,
        }))
        .filter((b) => b.title)
        .slice(0, 6),
    };
  } catch {
    return { results: [] }; // upstream down or slow — typing it by hand still works
  } finally {
    clearTimeout(timer);
  }
}

// ---- The library: server-side, so it follows the reader across devices ----
// One document per user holding their whole shelf. A library is small (tens of books),
// so whole-document sync keeps the client trivial and the data always consistent.
async function getBooks() {
  const doc = await col('books').findOne({ _id: 'library' });
  return { books: doc?.books || [], updatedAt: doc?.updatedAt || null };
}

async function saveBooks(books) {
  if (!Array.isArray(books)) throw new Error('books must be an array');
  if (books.length > 500) throw new Error('too many books');
  const clean = books.slice(0, 500).map((b) => ({
    id: String(b.id || Date.now().toString(36)),
    title: String(b.title || '').slice(0, 300),
    author: String(b.author || '').slice(0, 200),
    total: b.total == null ? null : Number(b.total) || null,
    page: Number(b.page) || 0,
    status: ['reading', 'finished', 'want'].includes(b.status) ? b.status : 'reading',
    rating: Math.max(0, Math.min(5, Number(b.rating) || 0)),
    notes: (Array.isArray(b.notes) ? b.notes : []).slice(-500).map((n) => ({
      text: String(n.text || '').slice(0, 4000),
      page: n.page == null ? null : Number(n.page) || null,
      ts: Number(n.ts) || Date.now(),
    })),
    cover: b.cover == null ? null : Number(b.cover) || null, // Open Library cover id
    // How this book is holding up in the quiz. Kept per book rather than per thought: it's
    // the book fading that's worth knowing, and it keeps the document small.
    quiz: b.quiz
      ? {
          asked: Math.max(0, Math.min(9999, Number(b.quiz.asked) || 0)),
          right: Math.max(0, Math.min(9999, Number(b.quiz.right) || 0)),
          last: Number(b.quiz.last) || null,
        }
      : null,
    exam: b.exam ? { score: Number(b.exam.score) || 0, ts: Number(b.exam.ts) || Date.now(), verdict: String(b.exam.verdict || '').slice(0, 600) } : null,
    started: Number(b.started) || Date.now(),
    updated: Number(b.updated) || Date.now(),
  }));
  await col('books').updateOne({ _id: 'library' }, { $set: { books: clean, updatedAt: new Date() } }, { upsert: true });
  return { ok: true, count: clean.length };
}

// ---- the owner's admin view ----
// Deliberately one page of facts, not a dashboard: who joined, how they arrived, and the
// only number that matters — did they add a book.
async function adminPage() {
  const [people, shares, stats, invites, visits, threads] = await Promise.all([
    rawCol('users').find().sort({ createdAt: -1 }).limit(200).toArray(),
    rawCol('shares').find().sort({ createdAt: -1 }).limit(20).toArray(),
    dbStats().catch(() => null),
    users.listInvites(),
    rawCol('meta').find({ _id: { $regex: '^visits:' } }).sort({ _id: -1 }).limit(7).toArray(),
    contact.allThreads().catch(() => []),
  ]);
  const waiting = threads.reduce((n, t) => n + (t.unreadOwner ? 1 : 0), 0);
  // Sign-ups per day, so the funnel finishes on the same row. "25 reached sign-in" sitting
  // in one table while "4 people" sits in another is what made these numbers look broken.
  const signupsOn = {};
  for (const u of people) {
    const d = u.createdAt ? new Date(u.createdAt).toISOString().slice(0, 10) : null;
    if (d) signupsOn[d] = (signupsOn[d] || 0) + 1;
  }
  const rows = await Promise.all(
    people.map(async (u) => {
      const [shelf, msgs, exams] = await Promise.all([
        rawCol('books').findOne({ userId: u._id }),
        rawCol('conversation').countDocuments({ userId: u._id, role: 'user' }),
        rawCol('book_exams').countDocuments({ userId: u._id, status: 'graded' }),
      ]);
      const list = shelf?.books || [];
      return { u, books: list.length, thoughts: list.reduce((n, b) => n + (b.notes?.length || 0), 0), msgs, exams };
    })
  );
  const withBooks = rows.filter((r) => r.books > 0).length;
  // The number that actually matters, now that the promise is "keep what you read".
  // A book with no thoughts against it is somebody who tried and got nothing back.
  const withThoughts = rows.filter((r) => r.thoughts > 0).length;
  // Came back on a LATER DAY than they joined. Not "opened it twice in one excited evening" —
  // that is curiosity. Returning on another day is the first evidence of a habit, and the
  // first thing that would make a subscription anything other than wishful.
  const dayOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const cameBack = rows.filter(({ u }) => u.lastSeen && dayOf(u.lastSeen) > dayOf(u.createdAt)).length;

  // ---- THE PIPELINE, and where it breaks ----
  // The journey is press it -> use it -> keep it, and until now its three steps lived in
  // three different tables with different time bases, so the one question worth asking —
  // WHERE do people fall out — could not be read off the page at all.
  // Seven days, every step on the same basis, and the drop stated between each pair. The
  // biggest drop is the only thing worth working on next.
  const since = new Date(Date.now() - 7 * 864e5);
  const sinceDay = since.toISOString().slice(0, 10);
  const week = visits.filter((v) => String(v._id).slice(7) >= sinceDay);
  const sum = (sel) => week.reduce((n, v) => n + sel(v), 0);
  const shelves = await rawCol('books').find({}, { projection: { userId: 1, 'books.notes.ts': 1 } }).toArray();
  const keptThisWeek = new Set(
    shelves.filter((sh) => (sh.books || []).some((b) => (b.notes || []).some((n) => n.ts && new Date(n.ts) >= since)))
      .map((sh) => sh.userId)
  ).size;
  const funnel = [
    ['Saw the front page', sum((v) => v.landing?.people || 0), 'anyone who loaded readkept.com'],
    ['Opened the app', sum((v) => v.app?.people || 0), 'pressed the one button'],
    ['Signed up', people.filter((u) => u.createdAt && new Date(u.createdAt) >= since).length, 'made an account'],
    ['Kept a thought', keptThisWeek, 'actually used it — the first real signal'],
    ['Came back another day', rows.filter(({ u }) => u.lastSeen && new Date(u.lastSeen) >= since && dayOf(u.lastSeen) > dayOf(u.createdAt)).length, 'a habit starting'],
    ['On a home screen', people.filter((u) => u.installedAt && new Date(u.installedAt) >= since).length, 'reached the end of the pipeline'],
  ];
  const drops = funnel.map(([, n], i) => (i === 0 || !funnel[i - 1][1] ? null : Math.round((1 - n / funnel[i - 1][1]) * 100)));
  const worst = drops.reduce((best, d, i) => (d != null && (best < 0 || d > drops[best]) ? i : best), -1);
  const funnelRows = funnel
    .map(([label, n, why], i) => `<tr${i === worst ? ' class="leak"' : ''}>
      <td><b>${i + 1}</b> ${esc(label)}</td>
      <td class="${n ? 'good' : 'bad'}" style="font-weight:700">${n}</td>
      <td class="dim">${drops[i] == null ? '' : `−${drops[i]}%`}${i === worst ? ' <span class="tag">biggest drop</span>' : ''}</td>
      <td class="dim">${esc(why)}</td></tr>`)
    .join('');
  const joined = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');
  const via = (u) => (u.referredBy ? 'share' : String(u._id).startsWith('g:') ? 'google' : 'telegram');

  const body = rows
    .map(({ u, books, thoughts, msgs, exams }) => {
      const dot = u.status === 'active' ? '#43B571' : u.status === 'blocked' ? '#E1685C' : '#D9AE4A';
      return `<tr>
      <td><span class="dot" style="background:${dot}"></span>${esc(u.displayName || u.name || u._id)}
        ${u.username ? `<span class="dim">@${esc(u.username)}</span>` : ''}
        ${u.role === 'owner' ? '<span class="tag">owner</span>' : ''}</td>
      <td class="dim">${via(u)}</td>
      <td class="dim">${esc(u.language || '—')}</td>
      <td class="${books ? 'good' : 'dim'}">${books}</td>
      <td class="${thoughts ? 'good' : 'dim'}">${thoughts}</td>
      <td class="dim">${msgs}</td>
      <td class="${exams ? 'good' : 'dim'}">${exams}</td>
      <td class="dim">${joined(u.createdAt)}</td>
      <td class="${u.lastSeen && joined(u.lastSeen) > joined(u.createdAt) ? 'good' : 'dim'}">${joined(u.lastSeen)}</td>
      <td class="dim">${u.strikes ? '⚠️ ' + u.strikes : ''}</td>
    </tr>`;
    })
    .join('');

  // The inbox. Oldest message at the top of each thread, so a conversation reads downwards
  // the way every other conversation does.
  const when = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');
  const threadCards = threads
    .map((t) => {
      const msgs = (t.msgs || [])
        .map(
          (m) => `<div class="m ${m.from === 'me' ? 'mine' : 'theirs'}">
            <div class="mt">${esc(m.text)}</div><div class="mw">${when(m.ts)}</div></div>`
        )
        .join('');
      // A guest is shown as a guest. Inventing a name for somebody who never gave one is how
      // an inbox starts lying to you about who you're talking to.
      const who = t.name
        ? esc(t.name)
        : t.userId
          ? esc(t.userId)
          : '<span class="dim">Not signed in</span>';
      return `<div class="thread${t.unreadOwner ? ' hot' : ''}" id="t-${esc(t._id)}">
      <div class="thead">
        <div><b>${who}</b>${t.email ? ` <span class="dim">${esc(t.email)}</span>` : ''}
          ${t.unreadOwner ? `<span class="tag">${t.unreadOwner} new</span>` : ''}</div>
        <div class="dim" style="font-size:.74rem">${t.from ? esc(t.from) + ' · ' : ''}${when(t.updated)}</div>
      </div>
      <div class="msgs">${msgs}</div>
      <form method="POST" action="/admin/reply" class="reply">
        <input type="hidden" name="id" value="${esc(t._id)}">
        <textarea name="text" rows="2" placeholder="Write back…" required></textarea>
        <button type="submit">Send</button>
      </form>
      ${t.unreadOwner
        ? `<form method="POST" action="/admin/read" style="margin:6px 0 0">
             <input type="hidden" name="id" value="${esc(t._id)}">
             <button class="danger" type="submit">Mark read, no reply</button></form>`
        : ''}
    </div>`;
    })
    .join('');

  // A share with no score used to render as "—%", a dash wearing a percent sign. And an
  // empty share looked identical to a real one, so four test links were indistinguishable
  // from four people sharing their reading. Show what's actually on the page, and give
  // every row a delete — the privacy page promises a share can be removed on request, and
  // until now there was no way to keep that promise.
  const shareRows = shares
    .map((s) => {
      const thoughts = (Array.isArray(s.thoughts) ? s.thoughts.length : s.thought ? 1 : 0);
      const empty = !thoughts && s.score == null;
      return `<tr>
      <td>${esc(s.title)}${empty ? ' <span class="dim">(empty)</span>' : ''}</td>
      <td class="dim">${s.score == null ? '—' : s.score + '%'}</td>
      <td class="dim">${thoughts || '—'}</td>
      <td class="dim">${s.views || 0}</td>
      <td class="${s.joins ? 'good' : 'dim'}">${s.joins || 0}</td>
      <td class="dim">${joined(s.createdAt)}</td>
      <td><form method="POST" action="/admin/unshare" style="margin:0">
        <input type="hidden" name="code" value="${esc(s._id)}">
        <button class="danger" type="submit">Delete</button></form></td></tr>`;
    })
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Kept · admin</title>
<meta name="color-scheme" content="dark"><style>
 *{box-sizing:border-box}body{margin:0;background:#14130F;color:#ECE8DF;padding:22px 16px 60px;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5}
 .wrap{max-width:900px;margin:0 auto}
 h1{font-family:Georgia,serif;font-size:1.5rem;margin:0 0 4px}
 .sub{color:#9C9686;font-size:.9rem;margin:0 0 20px}
 .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:24px}
 .card{background:#1D1B16;border:1px solid #2C2A22;border-radius:14px;padding:14px}
 .card .n{font-family:Georgia,serif;font-size:1.9rem;font-weight:700;line-height:1}
 .card .l{color:#9C9686;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;margin-top:4px}
 h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.1em;color:#D9AE4A;margin:26px 0 10px}
 table{width:100%;border-collapse:collapse;font-size:.88rem}
 th{text-align:left;font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:#6E695C;
  font-weight:600;padding:6px 8px;border-bottom:1px solid #2C2A22}
 td{padding:9px 8px;border-bottom:1px solid #22201A;vertical-align:top}
 .dim{color:#9C9686}.good{color:#43B571;font-weight:600}
 .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:middle}
 .tag{background:#2C2510;color:#D9AE4A;font-size:.64rem;padding:2px 6px;border-radius:20px;margin-left:6px}
 .scroll{overflow-x:auto}
 tr.leak td{background:#2A1A16}
 .bad{color:#E1685C;font-weight:600}
 .note{color:#6E695C;font-size:.82rem;margin-top:18px}
 a{color:#D9AE4A}
 .invite{display:flex;gap:8px;margin-bottom:4px}
 .invite input{flex:1;background:#26241D;border:1px solid #2C2A22;color:#ECE8DF;border-radius:10px;
  padding:10px 12px;font-size:.92rem;font-family:inherit}
 .invite button{background:#D9AE4A;color:#14130F;border:0;border-radius:10px;padding:10px 18px;
  font-weight:700;cursor:pointer;font-family:inherit}
 button.danger{background:transparent;border:1px solid #2C2A22;color:#E1685C;border-radius:8px;
  padding:5px 11px;font-size:.78rem;cursor:pointer;font-family:inherit}
 /* Tabs. Every panel is visible until the script says otherwise, so if the script never
    runs the page is exactly the long scroll it has always been. Doing it the other way —
    hiding panels in CSS and revealing one with JS — means a single script error hides the
    whole admin page, and the one page you'd use to find out something is wrong is the page
    that broke. Safe failure over tidy markup. */
 .tabs{display:flex;gap:6px;margin:0 0 20px;border-bottom:1px solid #2C2A22;overflow-x:auto}
 .tabs a{color:#9C9686;text-decoration:none;padding:9px 14px;border-radius:10px 10px 0 0;
  font-size:.86rem;white-space:nowrap;border-bottom:2px solid transparent}
 .tabs a.on{color:#D9AE4A;border-bottom-color:#D9AE4A;background:#1D1B16}
 .tabs .pill{background:#E1685C;color:#14130F;font-size:.66rem;font-weight:800;
  padding:1px 6px;border-radius:20px;margin-left:6px}
 body.tabbed .panel{display:none}
 body.tabbed .panel.on{display:block}
 .thread{background:#1D1B16;border:1px solid #2C2A22;border-radius:14px;padding:14px;margin-bottom:12px}
 .thread.hot{border-color:#D9AE4A}
 .thead{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px}
 .msgs{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
 .m{max-width:88%;padding:9px 12px;border-radius:13px;font-size:.9rem}
 .m .mt{white-space:pre-wrap;overflow-wrap:anywhere}
 .m .mw{font-size:.68rem;color:#6E695C;margin-top:4px}
 .m.theirs{background:#26241D;align-self:flex-start;border-bottom-left-radius:4px}
 .m.mine{background:#2C2510;align-self:flex-end;border-bottom-right-radius:4px}
 .reply{display:flex;gap:8px;align-items:flex-end}
 .reply textarea{flex:1;background:#26241D;border:1px solid #2C2A22;color:#ECE8DF;border-radius:10px;
  padding:10px 12px;font-size:.92rem;font-family:inherit;resize:vertical}
 .reply button{background:#D9AE4A;color:#14130F;border:0;border-radius:10px;padding:11px 18px;
  font-weight:700;cursor:pointer;font-family:inherit}
 .empty{color:#6E695C;background:#1D1B16;border:1px dashed #2C2A22;border-radius:14px;padding:22px;text-align:center}
</style></head><body><div class="wrap">
<h1>📕 Kept · admin</h1>
<p class="sub">Live from the database. <a href="/app">← back to the app</a></p>
<nav class="tabs">
  <a href="#overview" data-tab="overview">Overview</a>
  <a href="#messages" data-tab="messages">Messages${waiting ? `<span class="pill">${waiting}</span>` : ''}</a>
  <a href="#reach" data-tab="reach">Who turned up</a>
  <a href="#access" data-tab="access">Access</a>
</nav>
<section class="panel" id="overview">
<h2>The pipeline · last 7 days</h2>
<p class="dim" style="font-size:.86rem;margin:0 0 10px">Press it, use it, keep it — every step on the
  same seven days, so the drop between them is a real number. The row marked below is where
  most people are lost, and it is the only one worth working on next.</p>
<div class="scroll"><table>
<tr><th>Step</th><th>People</th><th>Drop</th><th>What it means</th></tr>
${funnelRows}
</table></div>
<div class="cards" style="margin-top:24px">
  <div class="card"><div class="n">${people.length}</div><div class="l">People</div></div>
  <div class="card"><div class="n">${people.filter((u) => u.status === 'active').length}</div><div class="l">Active</div></div>
  <div class="card"><div class="n" style="color:${withBooks ? '#43B571' : '#E1685C'}">${withBooks}</div><div class="l">Added a book</div></div>
  <div class="card"><div class="n" style="color:${withThoughts ? '#43B571' : '#E1685C'}">${withThoughts}</div><div class="l">Kept a thought</div></div>
  <div class="card"><div class="n" style="color:${cameBack ? '#43B571' : '#E1685C'}">${cameBack}</div><div class="l">Came back</div></div>
  <div class="card"><div class="n">${rows.reduce((n, r) => n + r.exams, 0)}</div><div class="l">Exams taken</div></div>
  <div class="card"><div class="n">${stats ? stats.totalMB.toFixed(0) : '?'}<span style="font-size:.9rem">/512MB</span></div><div class="l">Storage</div></div>
</div>
<h2>Everyone</h2>
<div class="scroll"><table>
<tr><th>Name</th><th>Via</th><th>Lang</th><th>Books</th><th>Thoughts</th><th>Msgs</th><th>Exams</th><th>Joined</th><th>Last seen</th><th></th></tr>
${body}
</table></div>
${shares.length ? `<h2>Shared results</h2><div class="scroll"><table>
<tr><th>Book</th><th>Score</th><th>Thoughts</th><th>Views</th><th>Joins</th><th>Made</th><th></th></tr>
${shareRows}</table></div>` : ''}
</section>

<section class="panel" id="messages">
<h2>Messages</h2>
<p class="dim" style="font-size:.86rem;margin:0 0 14px">
  Anyone can write from the menu in the app — <b>including people who never signed in</b>,
  which is the point: "I couldn't get past the Google button" can only ever be sent by
  somebody without an account. Replying here puts your answer in their app, and they see a
  dot on the menu until they read it.
</p>
${threads.length ? threadCards : '<div class="empty">Nobody has written yet.</div>'}
</section>

<section class="panel" id="access">
<h2>Access</h2>
<p class="dim" style="font-size:.88rem;margin:0 0 14px">
  <b>The website</b> —
  ${config.inviteOnly
    ? '🔒 <b>closed beta</b>: only the addresses below (plus yours) can sign in. Set <code>INVITE_ONLY=false</code> in Railway to open it.'
    : '🌍 <b>open</b>: anyone can sign in with Google and start reading. Set <code>INVITE_ONLY=true</code> in Railway to close it.'}
  <br><b>The Telegram bot</b> —
  ${config.multiTenant
    ? (config.autoAccept
        ? '🌍 open: it answers anyone who starts it.'
        : '🔒 approve-first: new people wait until you approve them.')
    : '🔒 owner only: it ignores everyone but you. (<code>MULTI_TENANT</code> is not <code>true</code>.)'}
  <br><b>This admin page</b> — always yours alone: <b>${esc(config.ownerEmail)}</b>.
  Nobody else can open it, however they signed in.
</p>
${config.inviteOnly
  ? `<form method="POST" action="/admin/invite" class="invite">
      <input name="email" type="email" placeholder="name@example.com" required>
      <button type="submit">Invite</button>
    </form>
    <div class="scroll"><table>
    <tr><th>Invited address</th><th>Added</th><th>Status</th><th></th></tr>
    ${invites.length
      ? invites.map((i) => {
          const acct = people.find((u) => u.google?.email === i._id);
          return `<tr><td>${esc(i._id)}</td><td class="dim">${joined(i.addedAt)}</td>
            <td class="${acct ? 'good' : 'dim'}">${acct ? 'signed in' : 'not yet'}</td>
            <td><form method="POST" action="/admin/revoke" style="margin:0">
              <input type="hidden" name="email" value="${esc(i._id)}">
              <button class="danger" type="submit">Revoke</button></form></td></tr>`;
        }).join('')
      : '<tr><td colspan="4" class="dim">Nobody invited yet.</td></tr>'}
    </table></div>`
  : ''}
</section>

<section class="panel" id="reach">
<h2>Who turned up</h2>
<p class="dim" style="font-size:.86rem;margin:0 0 10px">
  Everything above counts people who <b>signed in</b>. This counts everyone who loaded a page,
  so a quiet week can be told apart from a week where people arrived and left at the sign-in
  screen. One number per day — no cookie, no identifier, nothing about any person.
  <b>Link previews</b> are the scrapers LinkedIn, WhatsApp and the rest send when your link is
  posted: they prove the link was shared, not that anyone clicked it.
</p>
<div class="scroll"><table>
<tr><th>Day</th><th>Front page</th><th>Opened the app</th><th>Signed up</th><th>Couldn't — social app</th><th>Link previews</th></tr>
${visits.length
  ? visits.map((v) => `<tr><td>${esc(String(v._id).slice(7))}</td>
      <td class="${v.landing?.people ? 'good' : 'dim'}">${v.landing?.people || 0}</td>
      <td class="${v.app?.people ? 'good' : 'dim'}">${v.app?.people || 0}</td>
      <td class="${signupsOn[String(v._id).slice(7)] ? 'good' : 'bad'}">${signupsOn[String(v._id).slice(7)] || 0}</td>
      <td class="${(v.landing?.inapp || 0) + (v.app?.inapp || 0) ? 'bad' : 'dim'}">${(v.landing?.inapp || 0) + (v.app?.inapp || 0)}</td>
      <td class="dim">${(v.landing?.bots || 0) + (v.app?.bots || 0)}</td></tr>`).join('')
  : '<tr><td colspan="6" class="dim">Counting starts from this deploy — nothing recorded before it.</td></tr>'}
</table></div>
<p class="note">“Kept a thought” is the number that matters now — a book with nothing written against it is somebody who tried and got nothing back.</p>
</section>
</div>
<script>
// Enhancement only. The class that hides panels is added HERE, by the script — so until the
// script runs, and forever if it fails, every panel is on screen and nothing is lost.
(function(){
  var panels=[].slice.call(document.querySelectorAll('.panel'));
  var tabs=[].slice.call(document.querySelectorAll('.tabs a'));
  if(!panels.length||!tabs.length) return;
  document.body.classList.add('tabbed');
  function show(name){
    var found=false;
    panels.forEach(function(p){ var on=p.id===name; p.classList.toggle('on',on); if(on) found=true; });
    tabs.forEach(function(t){ t.classList.toggle('on',t.dataset.tab===name); });
    // An unknown hash must never leave a blank page staring back.
    if(!found) show('overview');
  }
  show((location.hash||'#overview').slice(1));
  window.addEventListener('hashchange',function(){ show((location.hash||'#overview').slice(1)); });
})();
</script>
</body></html>`;
}

// ---- Sharing: a result that travels beyond Telegram ----
// A public page per shared result, so it opens on WhatsApp, X, LinkedIn, Reddit — anywhere
// a link goes — carrying a deep link back into the bot. Only what they chose to share is
// published: the book, the score, and optionally one thought. Never their library.
// A share link is the only thing protecting what's on that page. The old code was
// Math.random().toString(36).slice(2,8) plus the last 3 chars of Date.now() — about 31 bits
// from a non-cryptographic PRNG, with a suffix that is literally the clock (every share
// made in the same 46 seconds ended in the same three characters). Guessable links were
// survivable when a share was one line; they are not now that a page carries six personal
// thoughts the reader chose to send to specific people.
// 16 hex chars = 64 bits from the CSPRNG. Old 9-char links keep working.
const shareCode = () => crypto.randomBytes(8).toString('hex');

async function createShare({ title, author, score, verdict, thoughts, thought, name }) {
  const code = shareCode();
  // ONLY what they ticked in the share sheet. This used to publish whichever note happened
  // to be last, without asking — which is how a private thought ends up on a public URL.
  const picked = (Array.isArray(thoughts) ? thoughts : thought ? [{ text: thought }] : [])
    .slice(0, MAX_SHARED_THOUGHTS)
    .map((t) => ({
      text: String(t?.text || '').trim().slice(0, 500),
      page: t?.page == null ? null : Number(t.page) || null,
    }))
    .filter((t) => t.text);

  await rawCol('shares').insertOne({
    _id: code,
    userId: uid(),
    title: String(title || '').slice(0, 300),
    author: String(author || '').slice(0, 200),
    score: score == null ? null : Math.max(0, Math.min(100, Number(score) || 0)),
    verdict: String(verdict || '').slice(0, 400),
    thoughts: picked,
    name: String(name || '').slice(0, 60),
    createdAt: new Date(),
    views: 0,
  });
  const url = `${config.appUrl}/r/${code}`;
  return { code, url };
}

const MAX_SHARED_THOUGHTS = 6;
const REF_CODE = /^[a-z0-9]{4,24}$/i;

// Someone arrived from a shared page and has just signed in. Credit the person whose share
// brought them, and put THAT BOOK on their shelf — they came for a specific book, and an
// empty library is exactly where new readers stop.
// Attribution is once and first-link-wins: the conditional update is what makes that true,
// and only a real change increments the share's join count.
async function attributeReferral(code, acct) {
  try {
    const src = await rawCol('shares').findOne({ _id: code });
    if (!src || String(src.userId) === String(acct._id)) return; // no crediting yourself
    const claimed = await rawCol('users').updateOne(
      { _id: String(acct._id), referredBy: { $exists: false } },
      { $set: { referredBy: { shareCode: code, referrerId: src.userId, at: new Date() } } }
    );
    if (!claimed.modifiedCount) return; // already came from someone else
    await rawCol('shares').updateOne({ _id: code }, { $inc: { joins: 1 } });
    if (src.title) await runAs(acct, () => addBook({ title: src.title, author: src.author || '', status: 'want' }));
    console.log(`[share] ${acct._id} joined from ${code}`);
  } catch (e) {
    console.error('[share] attribution failed:', e.message); // never block a sign-in
  }
}

// Links already out in the world carry a single `thought`. Read both shapes forever —
// a shared page that 404s its own content is worse than any redesign is good.
// Repaired as it's read, not as it was written. Shares made before the transcription was
// fixed carry the printed page's line breaks, and a share page is the most public thing this
// app produces — the one place a mangled thought is seen by people who have never heard of
// Kept. The stored share is left exactly as it was made.
const sharedThoughts = (s) =>
  (Array.isArray(s.thoughts) && s.thoughts.length
    ? s.thoughts
    : s.thought
      ? [{ text: s.thought, page: null }]
      : []
  ).map((t) => ({ ...t, text: looksWrapped(t.text) ? reflow(t.text) : t.text }));

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// SVG has no text wrapping, so the card has to do it by hand.
function wrapSvgText(text, maxChars, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars) {
      if (line) lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    } else line = (line + ' ' + w).trim();
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[,.;:]?$/, '') + '…';
  }
  return lines;
}

// The card, drawn as SVG — downloadable for Instagram/X where a link alone won't travel.
// It leads with a THOUGHT, not the number. A percentage is a fact about the sharer and
// means nothing to someone who hasn't read the book; a real line from their reading is the
// only thing on here worth stopping a scroll for. The score rides along as a small badge.
function shareCard(s) {
  const title = s.title.length > 40 ? s.title.slice(0, 39) + '…' : s.title;
  const first = sharedThoughts(s)[0];
  const quote = first ? wrapSvgText(first.text, 46, 4) : [];
  const who = `${s.name || 'A reader'}${first?.page ? ` · p.${first.page}` : ''}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#14130F"/>
  <rect x="0" y="0" width="1200" height="8" fill="#D9AE4A"/>
  <text x="80" y="118" fill="#9C9686" font-family="Georgia,serif" font-size="28">What ${esc(who)} kept from</text>
  <text x="80" y="186" fill="#ECE8DF" font-family="Georgia,serif" font-size="54" font-weight="bold">${esc(title)}</text>
  ${s.author ? `<text x="80" y="232" fill="#9C9686" font-family="Georgia,serif" font-size="28">${esc(s.author)}</text>` : ''}
  ${quote.length
    ? `<rect x="80" y="276" width="6" height="${quote.length * 56 + 8}" fill="#D9AE4A"/>
  ${quote.map((l, i) => `<text x="112" y="${320 + i * 56}" fill="#ECE8DF" font-family="Georgia,serif" font-size="40" font-style="italic">${esc(l)}</text>`).join('\n  ')}`
    : `<text x="80" y="330" fill="#D9AE4A" font-family="Georgia,serif" font-size="120" font-weight="bold">${s.score == null ? '—' : `${s.score}%`}</text>`}
  ${quote.length && s.score != null
    ? `<text x="80" y="560" fill="#D9AE4A" font-family="Georgia,serif" font-size="34" font-weight="bold">${s.score}% on an honest test of the book</text>`
    : ''}
  <text x="80" y="592" fill="#6E695C" font-family="Georgia,serif" font-size="26">readkept.com — read it, prove you kept it</text>
</svg>`;
}

function sharePage(s) {
  const score = s.score == null ? '' : `${s.score}%`;
  const thoughts = sharedThoughts(s);
  const who = s.name || 'A reader';
  // The preview text is the first thought, because that is the part a stranger might
  // actually want to read. Falling back to the score only when there's nothing else.
  const lead = thoughts[0]?.text
    ? `“${thoughts[0].text.slice(0, 180)}${thoughts[0].text.length > 180 ? '…' : ''}”`
    : `${s.score != null ? `Scored ${s.score}% on an honest test of the book. ` : ''}Most people forget what they read.`;
  const headline = thoughts.length
    ? `What ${who} kept from “${s.title}”`
    : `${who} scored ${score} on “${s.title}”`;
  const cta = `${config.appUrl}/app?r=${s._id}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(who)} — ${esc(s.title)}${score ? ` · ${score}` : ''}</title>
<meta name="theme-color" content="#14130F">
<meta property="og:title" content="${esc(headline)}">
<meta property="og:description" content="${esc(lead)}">
<!-- A PNG, not the SVG card. Every platform that renders link previews — Telegram,
     WhatsApp, LinkedIn, Facebook, X — ignores SVG, so the generated card was invisible
     in exactly the places a share goes. The card is still served for anyone who wants
     it; this is the one the previews will actually draw. -->
<meta property="og:image" content="${config.appUrl}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${config.appUrl}/r/${s._id}"><meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(headline)}">
<meta name="twitter:description" content="${esc(lead)}">
<meta name="twitter:image" content="${config.appUrl}/og.png">
<!-- Shareable, but not searchable. Someone sending a friend their reading notes has not
     agreed to those notes turning up in Google. Link previews still work — noindex stops
     search engines keeping it, not messaging apps unfurling it. -->
<meta name="robots" content="noindex, nofollow">
<style>
 /* The page a stranger meets. It was dark with gold — the palette the whole product moved
    off — so a thought shared from a cream app opened as a black card. Same rule as everywhere
    else now: cream page, white card, black text, and yellow only where a highlighter goes. */
 :root{color-scheme:light dark;
   --paper:#FCFAF5;--surface:#FFFFFF;--ink:#191713;--muted:#55514A;--faint:#6C6759;
   --line:#E6E0D3;--mark:#FFF176;--mark-ink:#191713;--shadow:rgba(70,58,34,.10)}
 @media (prefers-color-scheme:dark){:root{
   --paper:#14130F;--surface:#1D1B16;--ink:#ECE8DF;--muted:#9C9686;--faint:#8A8478;
   --line:#2C2A22;--mark:#E8CB48;--mark-ink:#14130F;--shadow:rgba(0,0,0,.45)}}
 *{box-sizing:border-box} body{margin:0;background:var(--paper);color:var(--ink);
   font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.6;
   display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
 .card{max-width:560px;width:100%;background:var(--surface);border:1px solid var(--line);
   border-radius:20px;padding:32px 28px;box-shadow:0 18px 50px var(--shadow)}
 .kicker{color:var(--faint);font-size:.76rem;letter-spacing:.16em;text-transform:uppercase;font-weight:600}
 h1{font-family:Georgia,serif;font-size:1.75rem;margin:.5rem 0 .2rem;line-height:1.22}
 .author{color:var(--muted);margin:0 0 4px}
 .trail{margin:26px 0 8px;display:flex;flex-direction:column;gap:20px}
 .t{border-left:3px solid var(--line);padding-left:15px}
 /* The page number, marked the way you would mark it in the book itself. */
 .t .p{display:inline-block;font-size:.7rem;font-weight:700;letter-spacing:.04em;
   color:var(--mark-ink);background:var(--mark);border-radius:20px;padding:3px 9px;margin-bottom:7px}
 .t .q{font-family:Georgia,serif;font-size:1.14rem;line-height:1.6;color:var(--ink);white-space:pre-wrap}
 .cred{display:flex;align-items:center;gap:12px;background:var(--paper);border:1px solid var(--line);
   border-radius:13px;padding:13px 16px;margin-top:26px}
 .cred .n{font-family:Georgia,serif;font-size:1.9rem;font-weight:700;color:var(--ink);line-height:1}
 .cred .l{color:var(--muted);font-size:.86rem;line-height:1.35}
 .verdict{color:var(--muted);font-size:.93rem;margin-top:12px;font-style:italic}
 .pitch{margin:28px 0 14px;font-size:1.02rem;text-align:center;color:var(--muted)}
 .pitch b{color:var(--ink)}
 a.cta{display:block;background:var(--ink);color:var(--paper);text-decoration:none;font-weight:600;
   padding:15px;border-radius:12px;font-size:1.05rem;text-align:center}
 .foot{color:var(--faint);font-size:.78rem;margin-top:16px;text-align:center}
</style></head><body>
<div class="card">
  <div class="kicker">${thoughts.length ? `What ${esc(who)} kept` : 'Honest comprehension test'}</div>
  <h1>${esc(s.title)}</h1>
  ${s.author ? `<p class="author">${esc(s.author)}</p>` : ''}

  ${thoughts.length
    ? `<div class="trail">${thoughts
        .map(
          (t) => `<div class="t">${t.page ? `<span class="p">p.${esc(String(t.page))}</span>` : ''}
      <div class="q">${esc(t.text)}</div></div>`
        )
        .join('')}</div>`
    : ''}

  ${s.score != null
    ? `<div class="cred"><div class="n">${s.score}%</div>
    <div class="l">${esc(who)} was tested on this book — honest questions, honestly graded.</div></div>
    ${s.verdict ? `<div class="verdict">${esc(s.verdict)}</div>` : ''}`
    : ''}

  <p class="pitch">${thoughts.length
    ? `This is what ${esc(who)} kept while reading.<br><b>Keep your own the same way — free.</b>`
    : 'Keep what you take from the books you read.<br><b>Free, and it starts with one thought.</b>'}</p>
  <a class="cta" href="${cta}">Start your own library →</a>
  <div class="foot">For people who use what they read — not just finish it.</div>
</div></body></html>`;
}

// ---- Book knowledge exam: honest questions, honest grading ----
// Generate: 5 questions that test real understanding of THIS book — comprehension,
// application to the reader's own life, and one pushback. Grade: radical honesty — vague
// answers score low, with the weak spot named. Results feed Mind XP.
//
// Everything here speaks about the reader as "they". We never ask anyone their gender, so
// guessing one is guaranteed to be wrong for someone — and being called the wrong thing by
// your own examiner is exactly how a product stops feeling like it's yours.
async function generateExam({ title, author }) {
  if (!title) throw new Error('no title');
  const profile = await getProfile();
  const sys = `${languageRule()}
You are ${personName()}'s reading examiner. Write an exam for the book "${title}"${author ? ` by ${author}` : ''} that tests whether they ACTUALLY understood and can USE it — not trivia.
Refer to the reader as "you"; never assume their gender.
Exactly 5 questions, each answerable in 2-4 sentences:
- Q1-Q2: the book's core ideas (comprehension — could they explain them to a colleague?)
- Q3-Q4: application to their real life${profile.mission ? ` and what they're working toward (${profile.mission})` : ''} — make them use the idea, not recite it
- Q5: pushback — where might the author be wrong, or what's the strongest counter-argument?
Reply ONLY JSON, no fences: {"questions":["...","...","...","...","..."]}`;
  const raw = await chat({ system: sys, messages: [{ role: 'user', content: 'Write the exam.' }], maxTokens: 600, tier: 'deep' });
  const parsed = parseModelJson(raw);
  if (!parsed || !Array.isArray(parsed.questions) || parsed.questions.length < 3) throw new Error('exam generation failed');
  const eid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const questions = parsed.questions.slice(0, 5).map(String);
  await col('book_exams').insertOne({ eid, title, author: author || '', questions, ts: new Date(), status: 'open' });
  return { eid, questions };
}

async function gradeExam({ eid, answers }) {
  const exam = await col('book_exams').findOne({ eid });
  if (!exam) throw new Error('unknown exam');
  const list = exam.questions.map((q, i) => `Q${i + 1}: ${q}\nTHEIR ANSWER: ${String((answers || [])[i] || '(no answer)')}`).join('\n\n');
  const sys = `${languageRule()}
You are grading ${personName()}'s exam on "${exam.title}". Refer to the reader as "you"; never assume their gender. The standing order is radical honesty: real scores, never inflated, never cruel — precise. A vague, generic, or bluffed answer scores under 40. A solid answer with the book's actual idea scores 60-80. Genuine insight applied to their own life scores higher. For each answer: a 0-100 score and ONE sharp sentence of feedback (name the weak spot or what landed). Then an overall 0-100 (weighted judgment, not just the average) and a one-sentence verdict they'd thank you for.
Reply ONLY JSON, no fences: {"grades":[{"score":70,"feedback":"..."}],"overall":72,"verdict":"..."}`;
  const raw = await chat({ system: sys, messages: [{ role: 'user', content: list }], maxTokens: 900, tier: 'deep' });
  const parsed = parseModelJson(raw);
  if (!parsed || !Array.isArray(parsed.grades)) throw new Error('grading failed');
  const overall = Math.max(0, Math.min(100, Math.round(Number(parsed.overall) || 0)));
  await col('book_exams').updateOne(
    { eid },
    { $set: { answers, grades: parsed.grades, overall, verdict: parsed.verdict || '', gradedAt: new Date(), status: 'graded' } }
  );
  // Feed the life-System: the exam is real Mind work — and System pings still reach his chat.
  await logEvent('exam', { title: exam.title, score: overall });
  const pings = await system.recordAction({ type: 'log_exam', score: overall });
  await sendPings(pings);
  return { grades: parsed.grades, overall, verdict: parsed.verdict || '' };
}

// The deck and body pages are HTML fragments (authored for the Artifact host, which adds
// <head>). When we serve them ourselves we wrap them in a real document so mobile viewport,
// charset, and (for sub-pages) a "‹ Home" link all work.
function wrap(fragment, homeBar) {
  if (/<!doctype/i.test(fragment)) return fragment; // already a full document (home.html)
  const bar = homeBar
    ? '<div style="font-family:system-ui,-apple-system,sans-serif;padding:10px 16px;' +
      'border-bottom:1px solid rgba(128,128,128,.22);position:sticky;top:0;background:Canvas;z-index:50">' +
      '<a href="/" style="color:#0E7C86;text-decoration:none;font-weight:600;font-size:15px">&lsaquo; Home</a></div>'
    : '';
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<meta name="color-scheme" content="light dark">' +
    '<link rel="apple-touch-icon" href="/icon-180.png">' +
    '<link rel="icon" href="/icon.svg" type="image/svg+xml">' +
    '<script src="https://telegram.org/js/telegram-web-app.js"></script>' +
    '<style>*{box-sizing:border-box}html,body{margin:0}</style></head><body>' +
    bar + fragment +
    '<script>try{var t=window.Telegram&&window.Telegram.WebApp;if(t){t.ready();t.expand();}}catch(e){}</script>' +
    '</body></html>'
  );
}

// The baseline every site is expected to send, and this one sent none of them.
// The CSP is deliberately tight because the app is entirely self-hosted: the only outside
// origins it needs are Google's sign-in script and Telegram's Mini App shim. 'unsafe-inline'
// is unavoidable for now — every page here is a single file with inline <style>/<script> —
// so the CSP's real job is limiting WHERE anything can be loaded from or sent to.
// Framing is the one rule that can't be the same everywhere. /admin is a page of one-click
// POST buttons, so it must never be framed by anyone — but Telegram Web opens the Mini App
// inside an iframe, so a blanket 'none' would lock the bot's own users out of the app.
// X-Frame-Options can't express an allowlist, so it's sent only on the pages that deny all.
// Both policies are constants, so they're built once at load rather than reassembled on
// every request (including each of Railway's health checks).
const csp = (frameAncestors) =>
  [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://accounts.google.com https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    // blob: is required for the photo capture — the browser reads the chosen file through a
    // blob URL before downscaling it. Leaving it out silently broke photographing a page:
    // the image never loaded, so it failed before the model was ever called. A blob URL can
    // only be minted by this origin's own scripts, so it adds no new reach.
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "connect-src 'self' https://accounts.google.com",
    "frame-src https://accounts.google.com",
    // Google's redirect sign-in submits a form to accounts.google.com. Without it here the
    // button would be blocked by our own policy — the same way blob: silently killed photos.
    "form-action 'self' https://accounts.google.com",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');

const CSP_OPEN = csp("'self' https://web.telegram.org https://*.telegram.org");
const CSP_NO_FRAME = csp("'none'");

function setSecurityHeaders(res, { denyFraming = false } = {}) {
  res.setHeader('Content-Security-Policy', denyFraming ? CSP_NO_FRAME : CSP_OPEN);
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), interest-cohort=()');
  if (denyFraming) res.setHeader('X-Frame-Options', 'DENY');
}

// The build the server is running. An open app polls this and reloads itself when it
// changes, so a deploy reaches a phone that's been sitting on the kitchen table for a week
// without anybody being asked to do anything.
let BUILD = 'dev';

export function startServer(port = process.env.PORT || 8080, build = 'dev') {
  BUILD = build;
  const server = http.createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    setSecurityHeaders(res, { denyFraming: path.startsWith('/admin') });

    // Answered before the canonical-host redirect below. A health probe is asking "is this
    // process alive", and a 301 is not an answer to that — a checker that treats 3xx as
    // unhealthy would fail the deploy of a perfectly working app.
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    // One canonical host, always. If www ever reaches this app directly, send it to the apex.
    //
    // This is not tidiness. A session cookie set on www.readkept.com does not exist on
    // readkept.com — different host, no Domain attribute — so somebody who signed in on www
    // and then followed any of our own links (every share URL, the Google redirect URI and
    // config.appUrl are all on the apex) would arrive signed OUT, on a page that looks
    // broken. Two hosts also split the search ranking between identical copies.
    //
    // 301 rather than 302: permanent is what lets a browser and a crawler stop asking.
    const host = String(req.headers.host || '').toLowerCase();
    if (host.startsWith('www.')) {
      res.writeHead(301, { Location: `https://${host.slice(4)}${req.url || '/'}` });
      res.end();
      return;
    }
    // Crawlers ask for these two before anything else, and a 404 for both is what an
    // unfinished site looks like. Everything private is refused by name rather than by hope:
    // the app shell has nothing to read, and /r/ pages carry people's own reading notes —
    // "anyone with the link" was never meant to mean "anyone searching Google".
    if (path === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' });
      res.end(
        `User-agent: *\nAllow: /$\nAllow: /privacy\n` +
          `Disallow: /app\nDisallow: /admin\nDisallow: /api/\nDisallow: /r/\nDisallow: /auth/\n` +
          `Disallow: /hub\nDisallow: /deck\nDisallow: /body\nDisallow: /reading\nDisallow: /routine\nDisallow: /dashboard\n\n` +
          `Sitemap: ${config.appUrl}/sitemap.xml\n`
      );
      return;
    }
    if (path === '/sitemap.xml') {
      const day = new Date().toISOString().slice(0, 10);
      res.writeHead(200, { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=86400' });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          `  <url><loc>${config.appUrl}/</loc><lastmod>${day}</lastmod><priority>1.0</priority></url>\n` +
          `  <url><loc>${config.appUrl}/privacy</loc><lastmod>${day}</lastmod><priority>0.3</priority></url>\n` +
          `</urlset>\n`
      );
      return;
    }
    // Tiny, public, uncached: the whole point is that it always tells the truth.
    if (path === '/version') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ build: BUILD }));
      return;
    }
    // ---- signing in on the website ----
    // Telegram redirects here after the Login Widget. Verify, create the account if it's
    // their first time, set a session cookie, and drop them into the app.
    if (path === '/auth/telegram') {
      const q = Object.fromEntries(new URL(req.url, `https://${req.headers.host}`).searchParams);
      const tgUser = verifyTelegramLogin(q);
      if (!tgUser) {
        res.writeHead(302, { Location: '/signin?error=login' });
        res.end();
        return;
      }
      // Already signed in (with Google) and now connecting Telegram? Attach the chat to
      // that same account — otherwise they'd end up with two libraries.
      const existingId = readSession(parseCookies(req.headers.cookie).kept_session);
      const existing = existingId ? await rawCol('users').findOne({ _id: existingId }) : null;
      if (existing && !existing.chatId && String(existing._id).startsWith('g:')) {
        const taken = await rawCol('users').findOne({ _id: String(tgUser.id) });
        if (!taken) {
          await users.linkTelegram(existing._id, tgUser.id, tgUser.first_name);
          res.writeHead(302, { Location: '/app?linked=1' });
          res.end();
          return;
        }
      }
      const acct = await users.ensureUser({ chatId: tgUser.id, name: tgUser.first_name, username: tgUser.username });
      if (!users.isAllowed(acct)) {
        res.writeHead(302, { Location: '/signin?error=waiting' });
        res.end();
        return;
      }
      res.writeHead(302, { Location: '/app', 'Set-Cookie': sessionCookie(createSession(acct._id)) });
      res.end();
      return;
    }
    // Google sign-in: the browser posts the ID token it got from Google.
    if (path === '/auth/google' && req.method === 'POST') {
      const body = await readJson(req);
      const g = await verifyGoogleToken(body?.credential);
      if (!g) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
      // The allowlist decides before any account is created, so a stranger's sign-in
      // leaves no trace.
      if (!(await users.isEmailAllowed(g.email))) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_invited' }));
        return;
      }
      const acct = await users.resolveGoogleUser(g);
      if (!users.isAllowed(acct)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'waiting' }));
        return;
      }
      // They may have arrived from someone's shared page before they had an account.
      const ref = parseCookies(req.headers.cookie).kept_ref;
      if (ref && REF_CODE.test(ref)) await attributeReferral(ref, acct);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': [sessionCookie(createSession(acct._id)), clearedRefCookie],
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // Google's redirect sign-in lands here: it POSTs the credential as a normal form instead
    // of handing it to a popup. This is the path that works when Safari blocks the popup or
    // restricts third-party cookies — which, from the outside, looks exactly like a button
    // that does nothing. Nobody ever reported "the popup was blocked"; they reported "it
    // doesn't work", which is why this took so long to find.
    if (path === '/auth/google/redirect' && req.method === 'POST') {
      const raw = await new Promise((resolve) => {
        let d = '';
        req.on('data', (c) => { d += c; if (d.length > 8000) req.destroy(); });
        req.on('end', () => resolve(d));
        req.on('error', () => resolve(''));
      });
      const form = new URLSearchParams(raw);
      const cookies = parseCookies(req.headers.cookie);
      // Google sends the same token as a cookie and a form field; equal means the POST came
      // from the flow we started, not from someone else's page.
      const sent = form.get('g_csrf_token');
      if (!sent || sent !== cookies.g_csrf_token) {
        console.warn('[auth] google redirect: csrf token mismatch');
        res.writeHead(302, { Location: '/signin?error=login' });
        res.end();
        return;
      }
      const g = await verifyGoogleToken(form.get('credential'));
      if (!g || !(await users.isEmailAllowed(g.email))) {
        res.writeHead(302, { Location: '/signin?error=login' });
        res.end();
        return;
      }
      const acct = await users.resolveGoogleUser(g);
      if (!users.isAllowed(acct)) {
        res.writeHead(302, { Location: '/signin?error=waiting' });
        res.end();
        return;
      }
      const ref = cookies.kept_ref;
      if (ref && REF_CODE.test(ref)) await attributeReferral(ref, acct);
      console.log(`[auth] ${acct._id} signed in (redirect)`);
      res.writeHead(302, {
        Location: '/app',
        'Set-Cookie': [sessionCookie(createSession(acct._id)), clearedRefCookie],
      });
      res.end();
      return;
    }
    // Take everything and go. The privacy page has promised this from the day it was
    // written, and until now a reader on the web had no way to do it — the only export was a
    // Telegram command, which is useless to someone who signed in with Google.
    if (path === '/api/export') {
      const sid = readSession(parseCookies(req.headers.cookie).kept_session);
      const acct = sid ? await rawCol('users').findOne({ _id: sid }) : null;
      if (!acct || !users.isAllowed(acct)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Sign in first');
        return;
      }
      const data = await users.exportUserData(acct._id);
      const day = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="kept-${day}.json"`,
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(data, null, 2));
      return;
    }
    // ---- the pages that were only ever on one device ----
    //
    // The body map and the routine kept everything in localStorage and spoke to no server at
    // all. They sit in a menu next to Dashboard and Study deck, which do sync, so they look
    // like part of the same system — and then the entries made on a phone are simply absent
    // on a laptop, with no error and nothing to explain it. Exactly the shape of the mentor
    // writing to `reading` while the app read `books`.
    //
    // One small document per person per page. Deliberately dumb: the server does not care
    // what is inside, because these are private single-person notes, and a schema here would
    // have to be changed in two places every time one of those pages grows a field.
    if (path === '/api/personal') {
      const sid = readSession(parseCookies(req.headers.cookie).kept_session);
      const who = sid ? await rawCol('users').findOne({ _id: sid }) : null;
      const key = new URL(req.url, `https://${req.headers.host}`).searchParams.get('key') || '';
      // The key IS the capability, so a page can never read a store it isn't entitled to.
      if (!users.can(who, key)) {
        res.writeHead(who ? 403 : 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_yours' }));
        return;
      }
      const id = `${key}:${who._id}`;
      if (req.method === 'GET') {
        const doc = await rawCol('personal').findOne({ _id: id });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ state: doc?.state || null, updated: doc?.updated || null }));
        return;
      }
      if (req.method === 'PUT') {
        const body = await readJson(req, 400000);
        if (body?.state == null || typeof body.state !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_state' }));
          return;
        }
        await rawCol('personal').updateOne(
          { _id: id },
          { $set: { userId: who._id, kind: key, state: body.state, updated: new Date() } },
          { upsert: true }
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('GET or PUT');
      return;
    }

    // ---- writing to the person who made it ----
    // Deliberately outside the block below that demands an account. Everything else here is
    // work we do on a reader's behalf and have to bill to somebody; a message is the one
    // thing where the sender having no account IS the message. Every bug found so far was
    // found by the one person who could never be surprised by it.
    if (path === '/api/contact') {
      const cookies = parseCookies(req.headers.cookie);
      const sid = readSession(cookies.kept_session);
      const acct = sid ? await rawCol('users').findOne({ _id: sid }) : null;

      if (req.method === 'GET') {
        const id = contact.threadIdFor(acct, cookies.kept_mail);
        const thread = await contact.myThread(id);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(thread));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('POST or GET');
        return;
      }
      // A signed-in reader is rate-limited by who they are; a stranger by where they came
      // from, which is the only handle we have and is deliberately never stored.
      const bucket = acct?._id || `ip:${clientIp(req)}`;
      if (!users.rateLimit(`contact:${bucket}`, 8)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'slow_down' }));
        return;
      }
      const body = await readJson(req, 8000);
      // A guest who has never written gets an id now — at the moment they send, not before.
      let anon = cookies.kept_mail;
      const fresh = !acct && !/^a:[0-9a-f]{32}$/.test(String(anon || ''));
      if (fresh) anon = contact.newAnonId();
      const id = contact.threadIdFor(acct, anon);
      const out = await contact.fromReader({ threadId: id, acct, text: body?.text, page: body?.page });
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      if (fresh && out.ok) headers['Set-Cookie'] = mailCookie(anon);
      res.writeHead(out.ok ? 200 : out.error === 'too_many' ? 429 : 400, headers);
      res.end(JSON.stringify(out));
      return;
    }
    if (path === '/auth/logout') {
      res.writeHead(302, { Location: '/', 'Set-Cookie': clearedCookie });
      res.end();
      return;
    }

    // ---- the app itself ----
    // Signed in → the library. Not signed in → a sign-in screen. Deciding on the server
    // means the installed app never flashes marketing or a wrong screen first.
    // The app opens for everybody now, signed in or not. Twenty-six people reached a login
    // wall in one day and none of them got past it: we were asking a stranger to hand over a
    // Google account before showing them a single thing. Adding books, keeping thoughts and
    // the quiz all run on the device and cost nothing, so they need no account at all. The
    // account is asked for at the moment it starts to mean something — when the work would
    // otherwise be lost, or when an action costs real money.
    if (path === '/app' || path === '/signin') {
      countVisit('app', req.headers['user-agent']);
      // Launched from a home-screen icon: the manifest's start_url carries ?home=1, and that
      // url is frozen into the icon when it is installed. No script, no cookie, and it cannot
      // be faked by anything except deliberately typing it.
      const fromHome = String(req.url || '').includes('home=1');
      if (fromHome) countVisit('home', req.headers['user-agent']);
      const sid = readSession(parseCookies(req.headers.cookie).kept_session);
      // A signature alone isn't enough — the account must still exist and be allowed.
      // Otherwise a stale cookie loads the app shell and then every API call 401s, which
      // looks like the product is broken rather than "please sign in again".
      const acct = sid ? await rawCol('users').findOne({ _id: sid }) : null;
      const signedIn = !!acct && users.isAllowed(acct);
      // Reaching step three is a fact about a PERSON, not a day, so it is stamped on the
      // account the first time they arrive from their own home screen. Written once and
      // never again, so the date means "when they installed it", not "when they last opened
      // it". Never allowed to break the page load.
      if (fromHome && acct && !acct.installedAt) {
        rawCol('users').updateOne({ _id: acct._id }, { $set: { installedAt: new Date() } }).catch(() => {});
      }

      // Arrived from a shared page (/app?r=<code>). If they're already signed in, credit it
      // now; if not, remember it across the sign-in they're about to do.
      const code = new URL(req.url, `https://${req.headers.host}`).searchParams.get('r');
      const validRef = code && REF_CODE.test(code) ? code : null;
      if (validRef && signedIn) await attributeReferral(validRef, acct);

      // Already signed in and asking for the door? Say so with a redirect. Quietly serving
      // the app instead makes the tap look like it did nothing at all.
      if (path === '/signin' && signedIn) {
        res.writeHead(302, { Location: '/app' });
        res.end();
        return;
      }
      // /signin is the door, asked for deliberately. /app is the product, always open.
      const file = path === '/signin' ? '../webapp/signin.html' : '../reading/journal.html';
      // Guests are included deliberately: somebody who wrote in without an account is exactly
      // the person most likely to have given up, and the reply is the only thing that brings
      // them back. Failure here costs the dot and nothing else.
      const mailCount = await contact
        .unreadFor(contact.threadIdFor(acct, parseCookies(req.headers.cookie).kept_mail))
        .catch(() => 0);
      try {
        let html = await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
        html = html
          .replaceAll('GOOGLE_CLIENT_ID', config.googleClientId || '')
          .replaceAll('APP_URL', config.appUrl)
          // One injected fact instead of placeholders scattered through the markup. The menu
          // is built from it, so an unknown viewer gets the guest list rather than a control
          // that half-renders. Admin is absent from the payload for everyone but the owner —
          // it isn't hidden in the page, it was never sent.
          .replaceAll(
            'ME_JSON',
            JSON.stringify({
              guest: !signedIn,
              owner: acct?.role === 'owner',
              // What this person may open, asked as capabilities rather than as a role. The
              // menu is built from this list, so a reader is never sent the existence of a
              // page they cannot open — it is absent from the payload, not hidden in the
              // markup. The day any of these is sold, users.can() changes and the menu grows
              // for whoever bought it, with nothing here to edit.
              can: users.MODULES.filter((m) => users.can(acct, m)),
              // Replies waiting, so the menu can show a dot without the app having to ask.
              // Never allowed to break the page: a reader whose inbox lookup fails still gets
              // their library, they just don't get the dot.
              mail: mailCount,
            })
          );
        // Google is the only way in, so the page has to say something sensible if it isn't
        // configured — a sign-in screen with no button and no explanation reads as broken.
        html = config.googleClientId
          ? html.replace(/<!--NOGOOGLE-->[\s\S]*?<!--\/NOGOOGLE-->/g, '')
          : html.replace(/<!--GOOGLE-->[\s\S]*?<!--\/GOOGLE-->/g, '');
        const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
        if (validRef) headers['Set-Cookie'] = signedIn ? clearedRefCookie : refCookie(validRef);
        res.writeHead(200, headers);
        res.end(wrap(html, false));
      } catch (err) {
        console.error('[web] /app failed:', err.message);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server error');
      }
      return;
    }

    // ---- owner's admin ----
    // Who joined, where they came from, and whether they actually did anything. Rendered
    // on the server so there's no API to secure separately; the session must be the owner.
    if (path === '/admin' || path === '/admin/invite' || path === '/admin/revoke' || path === '/admin/unshare'
      || path === '/admin/reply' || path === '/admin/read') {
      const sid = readSession(parseCookies(req.headers.cookie).kept_session);
      const me = sid ? await rawCol('users').findOne({ _id: sid }) : null;
      if (!me || me.role !== 'owner') {
        res.writeHead(sid ? 403 : 302, sid ? { 'Content-Type': 'text/plain' } : { Location: '/app' });
        res.end(
          sid
            ? `Not yours.\n\nYou're signed in as ${me?.google?.email || me?.name || sid}, which isn't the owner account.\nSign out at /auth/logout and sign in with the owner's Google address.`
            : ''
        );
        return;
      }
      // Invites, share deletion and replies — plain form posts, so the page needs no JS.
      if (path === '/admin/invite' || path === '/admin/revoke' || path === '/admin/unshare'
        || path === '/admin/reply' || path === '/admin/read') {
        const raw = await new Promise((resolve) => {
          let d = '';
          req.on('data', (c) => { d += c; if (d.length > 4000) req.destroy(); });
          req.on('end', () => resolve(d));
          req.on('error', () => resolve(''));
        });
        const form = new URLSearchParams(raw);
        const email = form.get('email') || '';
        try {
          if (path === '/admin/unshare') {
            // Taking a public page down. The link 404s immediately after this.
            const code = form.get('code') || '';
            if (!REF_CODE.test(code)) throw new Error('bad share code');
            await rawCol('shares').deleteOne({ _id: code });
            console.log(`[admin] share ${code} deleted`);
          } else if (path === '/admin/reply') {
            await contact.fromOwner(form.get('id') || '', form.get('text') || '');
          } else if (path === '/admin/read') {
            await contact.markRead(form.get('id') || '');
          } else if (path === '/admin/invite') await users.inviteEmail(email, me._id);
          else await users.revokeEmail(email);
        } catch (e) {
          res.writeHead(302, { Location: '/admin?err=' + encodeURIComponent(e.message) });
          res.end();
          return;
        }
        // Back to the tab they were on, not the top of the page — replying to the third
        // message and being thrown back to the storage gauge is how an inbox goes unread.
        const back = path === '/admin/reply' || path === '/admin/read' ? '/admin#messages' : '/admin';
        res.writeHead(302, { Location: back });
        res.end();
        return;
      }
      try {
        // Build the page BEFORE writing headers — otherwise a failure mid-render leaves us
        // unable to send a 500 (headers already sent).
        const html = await adminPage();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (err) {
        console.error('[web] /admin failed:', err.message);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server error');
      }
      return;
    }

    // Public share pages — deliberately unauthenticated: that's the whole point. They
    // expose only what the reader chose to publish.
    const share = path.match(/^\/r\/([a-z0-9]{6,20})(\/card\.svg)?$/i);
    if (share) {
      const doc = await rawCol('shares').findOne({ _id: share[1] });
      if (!doc) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('This result has expired or was removed.');
        return;
      }
      if (share[2]) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
        res.end(shareCard(doc));
        return;
      }
      rawCol('shares').updateOne({ _id: doc._id }, { $inc: { views: 1 } }).catch(() => {});
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(sharePage(doc));
      return;
    }

    if (
      path === '/api/dashboard' || path === '/api/words' || path === '/api/bookrecs' ||
      path === '/api/bookexam' || path === '/api/bookexam/grade' || path === '/api/books' ||
      path === '/api/share' || path === '/api/chat' || path === '/api/booksearch' ||
      path === '/api/tidy' || path === '/api/readpage'
    ) {
      // Two ways to prove who you are: Telegram's Mini App signature, or a session cookie
      // from signing in on the website. The allowlist then decides if you're allowed in.
      const tgUser = verifyInitData(req.headers['x-telegram-init-data'] || '', config.telegramToken);
      const sid = tgUser ? null : readSession(parseCookies(req.headers.cookie).kept_session);
      const acct = tgUser
        ? await users.ensureUser({ chatId: tgUser.id, name: tgUser.first_name || '' })
        : sid
          ? await rawCol('users').findOne({ _id: sid })
          : null;
      // Whether anyone COMES BACK is the number that decides everything — whether the pitch
      // is true, whether the product is worth anything, whether a price could ever work.
      // lastSeen was only written at sign-in, and a session cookie means a daily reader signs
      // in once and never again, so a devoted user and a one-time visitor looked identical.
      // Written at most hourly: this is a retention signal, not a request log.
      if (acct && (!acct.lastSeen || Date.now() - new Date(acct.lastSeen).getTime() > 3600e3)) {
        rawCol('users').updateOne({ _id: acct._id }, { $set: { lastSeen: new Date() } })
          .catch(() => {});   // never let a metric break a reader's request
      }
      if (!acct || !users.isAllowed(acct)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      // A burst ceiling on the whole API. The Telegram side has had one since the doors
      // opened; the web side — now the only front door — had none, so a loop in a tab
      // could hammer Mongo and the model as fast as the network allowed.
      if (!users.rateLimit(`web:${acct._id}`, 40)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
        res.end(JSON.stringify({ error: 'slow_down' }));
        return;
      }
      try {
        // Everything inside runAs reads and writes only this user's data.
        // /api/words: the LIVE word bank — words the tutor caught them missing in chat
        // plus the curriculum words synced from english/words.md. Chat-caught first.
        const needsBody =
          path === '/api/bookexam' || path === '/api/bookexam/grade' || path === '/api/share' ||
          path === '/api/chat' || path === '/api/tidy' || path === '/api/readpage' ||
          (path === '/api/books' && req.method === 'PUT');
        // Only the photo endpoint may send more than 200KB, and only because it carries an
        // image the client has already downscaled.
        const body = needsBody ? await readJson(req, path === '/api/readpage' ? 2_000_000 : 200000) : null;
        const data = await runAs(acct, async () => {
          if (path === '/api/books') return req.method === 'PUT' ? saveBooks(body?.books) : getBooks();
          if (path === '/api/share') return createShare({ ...body, name: body?.name || acct.name });
          // The mentor, in the browser. Same brain, same memory, same logging as Telegram —
          // and the same guardrails, since a web message costs exactly as much as a chat one.
          if (path === '/api/chat') {
            if (req.method !== 'POST') return { messages: await coach.history() };
            const text = String(body?.text || '').trim();
            if (!text) return { error: 'empty' };
            const finding = moderation.screen(text, []);
            if (finding) return { reply: "That's outside what I do — I'm here for your books.", blocked: true };
            const quota = await users.consumeQuota(acct);
            if (!quota.ok) return { reply: `You've used today's ${quota.cap} messages. It resets tomorrow.`, blocked: true };
            // The reply, and only the reply. XP, levels, ranks and quests still run behind
            // this (they're the owner's private life OS) but the app is a library and a
            // mentor — a reader was never promised a game, so nothing gamified talks here.
            const { reply } = await coach.handle(text, null, { silent: true });
            return { reply };
          }
          if (path === '/api/words') {
            const rows = await col('english_words')
              .find()
              .sort({ source: 1, lastSeen: -1 }) // 'chat' < 'curriculum' alphabetically
              .limit(200)
              .toArray();
            return rows.map((r) => ({ word: r.word, note: r.why || r.note || '', count: r.count || 1, source: r.source || 'chat' }));
          }
          if (path === '/api/tidy') return tidyText(body?.text);
          if (path === '/api/readpage') {
            // A photograph costs far more than a message, so it draws on the same daily
            // allowance the exams do rather than being free to loop.
            const q = await users.consumeExam(acct);
            if (!q.ok) return { error: 'limit', message: `That's ${q.cap} photos and exams today — it resets tomorrow.` };
            return readPage(body?.image);
          }
          if (path === '/api/booksearch') {
            return searchBooks(new URL(req.url, `https://${req.headers.host}`).searchParams.get('q'));
          }
          if (path === '/api/bookrecs') return gatherBookRecs(/[?&]refresh=1/.test(req.url || ''));
          // Exams are the most expensive thing here — generate and grade both run the deep
          // model — and were the one endpoint with no ceiling of any kind. Generating spends
          // the budget, so it's counted; grading is free, or a reader could be charged for
          // an exam and then locked out of finishing it.
          if (path === '/api/bookexam') {
            const q = await users.consumeExam(acct);
            if (!q.ok) return { error: 'exam_limit', message: `That's ${q.cap} exams today — it resets tomorrow.` };
            return generateExam(body);
          }
          if (path === '/api/bookexam/grade') return gradeExam(body);
          return gatherDashboard();
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      } catch (err) {
        console.error('[web] api error:', path, err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'server' }));
      }
      return;
    }
    // Installable-app plumbing, so the site can be added to a home screen and opened
    // like a native app rather than a browser tab.
    if (path === '/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' });
      res.end(JSON.stringify({
        // What the install prompt says, and what sits under the icon afterwards. Both of these
        // still led with the exam, which is the old order — the exam is the dessert, not the
        // meal. Keeping the thought is the promise, so the promise is what the prompt makes.
        name: 'Kept — use what you read',
        short_name: 'Kept',
        start_url: '/app?home=1',
        display: 'standalone',
        background_color: '#14130F',
        theme_color: '#14130F',
        description: 'For people who use what they read — not just finish it. Keep a thought in seconds while you read, and find it again months later, with its page.',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
        // The installed app opens the LIBRARY, never the sales page.
        scope: '/',
      }));
      return;
    }
    if (path === '/icon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#14130F"/>' +
          '<rect x="150" y="120" width="212" height="272" rx="18" fill="#D9AE4A"/><rect x="150" y="120" width="46" height="272" rx="18" fill="#B8912F"/>' +
          '<path d="M232 268l30 30 62-72" stroke="#14130F" stroke-width="26" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      );
      return;
    }
    // The handful of real image files. An explicit map, not a static directory — nothing
    // should be able to ask this server for an arbitrary path. A missing file 404s cleanly:
    // the photo falls back to an initial rather than leaving a broken image behind.
    if (ASSETS[path]) {
      try {
        const buf = await readFile(fileURLToPath(new URL(`../webapp/${ASSETS[path].file}`, import.meta.url)));
        res.writeHead(200, { 'Content-Type': ASSETS[path].type, 'Cache-Control': 'public, max-age=86400' });
        res.end(buf);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
      return;
    }
    // Book covers, proxied so they load under img-src 'self' and no reader's IP is handed
    // to a third party. Strictly numeric — this must never become a general image relay.
    const cover = path.match(/^\/cover\/(\d{1,12})$/);
    if (cover) {
      try {
        const r = await fetch(`https://covers.openlibrary.org/b/id/${cover[1]}-M.jpg`, {
          headers: { 'User-Agent': 'Kept/1.0 (+https://readkept.com)' },
        });
        if (!r.ok) throw new Error('upstream');
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=2592000, immutable' });
        res.end(buf);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('no cover');
      }
      return;
    }
    if (path === '/sw.js') {
      // Deliberately minimal: claim control, serve the network. Caching pages that show
      // live personal data would be worse than useless.
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
      res.end("self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});");
      return;
    }

    const route = ROUTES[path];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    if (route.redirect) {
      res.writeHead(301, { Location: route.redirect });
      res.end();
      return;
    }
    // Entitlement, asked as a capability rather than as "is this the owner" — so the day any
    // of these becomes something people pay for, the answer changes in users.can() and every
    // page here follows without being touched.
    if (route.needs) {
      const sid = readSession(parseCookies(req.headers.cookie).kept_session);
      const who = sid ? await rawCol('users').findOne({ _id: sid }) : null;
      if (!users.can(who, route.needs)) {
        // Signed in but not entitled is a different fact from not signed in, and saying so
        // costs nothing: neither answer reveals whether the page holds anything.
        res.writeHead(sid ? 403 : 302, sid ? { 'Content-Type': 'text/plain' } : { Location: '/app' });
        res.end(sid ? 'Not yours.' : '');
        return;
      }
    }
    // A page that needs the /app handler's substitutions must never be served from here —
    // the placeholders would ship as literal text and the script would die on them.
    if (route.file && route.file.includes('journal.html')) {
      res.writeHead(301, { Location: '/app' });
      res.end();
      return;
    }
    try {
      const abs = fileURLToPath(new URL(route.file, import.meta.url));
      let fragment = await readFile(abs, 'utf8');
      // The landing page's call-to-action goes to /app, never out to Telegram: a stranger
      // clicking "start" should land in the product, not in a chat client they may not have.
      if (route.public) fragment = fragment.replaceAll('APP_URL', config.appUrl);
      if (path === '/') countVisit('landing', req.headers['user-agent']);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(wrap(fragment, route.homeBar));
    } catch (err) {
      console.error('[web] failed to serve', path, err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    }
  });

  server.on('error', (err) => console.error('[web] server error:', err.message));
  server.listen(port, () => console.log(`[web] Mini App serving on :${port}`));
  return server;
}
