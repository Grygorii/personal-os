import http from 'http';
import crypto from 'crypto';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { col, rawCol, getProfile, logEvent, dbStats } from './db.js';
import { config } from './config.js';
import { chat } from './llm.js';
import { sendPings } from './telegram.js';
import * as system from './system.js';
import * as users from './users.js';
import * as coach from './coach.js';
import * as moderation from './moderation.js';
import { runAs, uid, personName, languageRule } from './ctx.js';
import { verifyTelegramLogin, verifyGoogleToken, createSession, readSession, parseCookies, sessionCookie, clearedCookie, refCookie, clearedRefCookie } from './auth.js';
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
  '/': { file: '../webapp/landing.html', public: true },
  '/privacy': { file: '../webapp/privacy.html', public: true },
  '/hub': { file: '../webapp/home.html' },
  '/home': { file: '../webapp/home.html' },
  '/deck': { file: '../english/study.html', homeBar: true },
  '/body': { file: '../body/map.html', homeBar: true },
  // NOT the journal any more. This route served journal.html raw, so the placeholders the
  // /app handler fills in were shipped as literal text — OWNER_LINK printed on screen and
  // IS_GUEST threw a ReferenceError that killed the whole app script. Anyone still holding
  // an old link or home-screen icon from the Telegram days landed on a dead page.
  '/reading': { redirect: '/app' },
  '/routine': { file: '../routines/today.html', homeBar: true },
  '/dashboard': { file: '../webapp/dashboard.html' },
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
async function tidyText(raw) {
  const text = String(raw || '').trim().slice(0, 2000);
  if (text.length < 2) return { text };
  const sys = `${languageRule()}
You fix typing, nothing else, in a note ${personName()} jotted while reading.
Correct spelling, grammar and punctuation. Keep their exact words, their voice, their meaning
and their language. Never add an idea, never remove one, never summarise, never make it more
formal, never translate. If it already reads correctly, return it exactly as it is.
Reply with ONLY the corrected note. No preamble, no quotes, no explanation.`;
  const out = await chat({ system: sys, messages: [{ role: 'user', content: text }], maxTokens: 700 });
  const cleaned = String(out || '').trim().replace(/^["']|["']$/g, '');
  // A model that returns nothing, or an essay, gets ignored rather than trusted.
  if (!cleaned || cleaned.length > text.length * 3 + 80) return { text };
  return { text: cleaned.slice(0, 2000) };
}

// Read a photographed page. Returns the words on it and nothing else — no summary, no
// interpretation, because the reader is going to trim it down to the bit they wanted.
async function readPage(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('not an image');
  const [, mediaType, data] = m;
  if (data.length > 1_400_000) throw new Error('image too large');
  const sys = `${languageRule()}
You transcribe photographs of book pages.
Return ONLY the text visible in the image, as written, keeping its line breaks and punctuation.
If part is cut off or unreadable, leave it out rather than guessing. If the photo contains no
readable text, reply with exactly: NO_TEXT
Never summarise, never comment, never add anything of your own.`;
  const out = await chat({
    system: sys,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
      { type: 'text', text: 'Transcribe this page.' },
    ] }],
    maxTokens: 900,
  });
  const text = String(out || '').trim();
  if (!text || text === 'NO_TEXT') return { text: '', empty: true };
  return { text: text.slice(0, 4000) };
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
  const [people, shares, stats, invites, visits] = await Promise.all([
    rawCol('users').find().sort({ createdAt: -1 }).limit(200).toArray(),
    rawCol('shares').find().sort({ createdAt: -1 }).limit(20).toArray(),
    dbStats().catch(() => null),
    users.listInvites(),
    rawCol('meta').find({ _id: { $regex: '^visits:' } }).sort({ _id: -1 }).limit(7).toArray(),
  ]);
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
      <td class="dim">${u.strikes ? '⚠️ ' + u.strikes : ''}</td>
    </tr>`;
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
 .note{color:#6E695C;font-size:.82rem;margin-top:18px}
 a{color:#D9AE4A}
 .invite{display:flex;gap:8px;margin-bottom:4px}
 .invite input{flex:1;background:#26241D;border:1px solid #2C2A22;color:#ECE8DF;border-radius:10px;
  padding:10px 12px;font-size:.92rem;font-family:inherit}
 .invite button{background:#D9AE4A;color:#14130F;border:0;border-radius:10px;padding:10px 18px;
  font-weight:700;cursor:pointer;font-family:inherit}
 button.danger{background:transparent;border:1px solid #2C2A22;color:#E1685C;border-radius:8px;
  padding:5px 11px;font-size:.78rem;cursor:pointer;font-family:inherit}
</style></head><body><div class="wrap">
<h1>📕 Kept · admin</h1>
<p class="sub">Live from the database. <a href="/app">← back to the app</a></p>
<div class="cards">
  <div class="card"><div class="n">${people.length}</div><div class="l">People</div></div>
  <div class="card"><div class="n">${people.filter((u) => u.status === 'active').length}</div><div class="l">Active</div></div>
  <div class="card"><div class="n" style="color:${withBooks ? '#43B571' : '#E1685C'}">${withBooks}</div><div class="l">Added a book</div></div>
  <div class="card"><div class="n" style="color:${withThoughts ? '#43B571' : '#E1685C'}">${withThoughts}</div><div class="l">Kept a thought</div></div>
  <div class="card"><div class="n">${rows.reduce((n, r) => n + r.exams, 0)}</div><div class="l">Exams taken</div></div>
  <div class="card"><div class="n">${stats ? stats.totalMB.toFixed(0) : '?'}<span style="font-size:.9rem">/512MB</span></div><div class="l">Storage</div></div>
</div>
<h2>Everyone</h2>
<div class="scroll"><table>
<tr><th>Name</th><th>Via</th><th>Lang</th><th>Books</th><th>Thoughts</th><th>Msgs</th><th>Exams</th><th>Joined</th><th></th></tr>
${body}
</table></div>
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
${shares.length ? `<h2>Shared results</h2><div class="scroll"><table>
<tr><th>Book</th><th>Score</th><th>Thoughts</th><th>Views</th><th>Joins</th><th>Made</th><th></th></tr>
${shareRows}</table></div>` : ''}
<h2>Who turned up</h2>
<p class="dim" style="font-size:.86rem;margin:0 0 10px">
  Everything above counts people who <b>signed in</b>. This counts everyone who loaded a page,
  so a quiet week can be told apart from a week where people arrived and left at the sign-in
  screen. One number per day — no cookie, no identifier, nothing about any person.
  <b>Link previews</b> are the scrapers LinkedIn, WhatsApp and the rest send when your link is
  posted: they prove the link was shared, not that anyone clicked it.
</p>
<div class="scroll"><table>
<tr><th>Day</th><th>Front page</th><th>Reached sign-in</th><th>Signed up</th><th>Couldn't — social app</th><th>Link previews</th></tr>
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
</div></body></html>`;
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
const sharedThoughts = (s) =>
  Array.isArray(s.thoughts) && s.thoughts.length
    ? s.thoughts
    : s.thought
      ? [{ text: s.thought, page: null }]
      : [];

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
<meta property="og:image" content="${config.appUrl}/r/${s._id}/card.svg">
<meta property="og:url" content="${config.appUrl}/r/${s._id}"><meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(headline)}">
<meta name="twitter:description" content="${esc(lead)}">
<meta name="twitter:image" content="${config.appUrl}/r/${s._id}/card.svg">
<!-- Shareable, but not searchable. Someone sending a friend their reading notes has not
     agreed to those notes turning up in Google. Link previews still work — noindex stops
     search engines keeping it, not messaging apps unfurling it. -->
<meta name="robots" content="noindex, nofollow">
<style>
 :root{color-scheme:dark}
 *{box-sizing:border-box} body{margin:0;background:#14130F;color:#ECE8DF;
   font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.6;
   display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
 .card{max-width:560px;width:100%;background:#1D1B16;border:1px solid #2C2A22;border-radius:20px;padding:32px 28px}
 .kicker{color:#D9AE4A;font-size:.76rem;letter-spacing:.16em;text-transform:uppercase;font-weight:600}
 h1{font-family:Georgia,serif;font-size:1.75rem;margin:.5rem 0 .2rem;line-height:1.22}
 .author{color:#9C9686;margin:0 0 4px}
 .trail{margin:26px 0 8px;display:flex;flex-direction:column;gap:20px}
 .t{border-left:3px solid #D9AE4A;padding-left:15px}
 .t .p{display:inline-block;font-size:.7rem;font-weight:700;letter-spacing:.04em;color:#D9AE4A;
   background:#2C2510;border-radius:20px;padding:3px 9px;margin-bottom:7px}
 .t .q{font-family:Georgia,serif;font-size:1.08rem;line-height:1.55;color:#ECE8DF;white-space:pre-wrap}
 .cred{display:flex;align-items:center;gap:12px;background:#26241D;border-radius:13px;
   padding:13px 16px;margin-top:26px}
 .cred .n{font-family:Georgia,serif;font-size:1.9rem;font-weight:700;color:#D9AE4A;line-height:1}
 .cred .l{color:#9C9686;font-size:.86rem;line-height:1.35}
 .verdict{color:#C9C3B6;font-size:.93rem;margin-top:12px;font-style:italic}
 .pitch{margin:28px 0 14px;font-size:1.02rem;text-align:center}
 a.cta{display:block;background:#D9AE4A;color:#14130F;text-decoration:none;font-weight:700;
   padding:15px;border-radius:12px;font-size:1.05rem;text-align:center}
 .foot{color:#8A8478;font-size:.78rem;margin-top:16px;text-align:center}
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
    ? 'Read it too?<br><b>See how much of it you kept.</b>'
    : 'You forget most of what you read.<br><b>Find out how much you kept.</b>'}</p>
  <a class="cta" href="${cta}">📕 ${thoughts.length ? 'Add this book and test me' : 'Test me on a book'} →</a>
  <div class="foot">Read it. Prove you kept it.</div>
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
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
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
      const sid = readSession(parseCookies(req.headers.cookie).kept_session);
      // A signature alone isn't enough — the account must still exist and be allowed.
      // Otherwise a stale cookie loads the app shell and then every API call 401s, which
      // looks like the product is broken rather than "please sign in again".
      const acct = sid ? await rawCol('users').findOne({ _id: sid }) : null;
      const signedIn = !!acct && users.isAllowed(acct);

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
      try {
        let html = await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
        html = html
          .replaceAll('GOOGLE_CLIENT_ID', config.googleClientId || '')
          .replaceAll('APP_URL', config.appUrl)
          .replaceAll('IS_GUEST', signedIn ? 'false' : 'true')
          // The owner gets a way back to the admin page from his phone. For anybody else the
          // markup is removed here, so it isn't a hidden control they could find and press.
          .replaceAll(
            'OWNER_LINK',
            acct?.role === 'owner' ? '<a class="iconbtn wide" href="/admin">Admin</a>' : ''
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
    if (path === '/admin' || path === '/admin/invite' || path === '/admin/revoke' || path === '/admin/unshare') {
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
      // Invites and share deletion — plain form posts, so the page needs no JS.
      if (path === '/admin/invite' || path === '/admin/revoke' || path === '/admin/unshare') {
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
          } else if (path === '/admin/invite') await users.inviteEmail(email, me._id);
          else await users.revokeEmail(email);
        } catch (e) {
          res.writeHead(302, { Location: '/admin?err=' + encodeURIComponent(e.message) });
          res.end();
          return;
        }
        res.writeHead(302, { Location: '/admin' });
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
        name: 'Kept — read it, prove you kept it',
        short_name: 'Kept',
        start_url: '/app',
        display: 'standalone',
        background_color: '#14130F',
        theme_color: '#14130F',
        description: 'Get examined on the books you finish. Honestly.',
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
