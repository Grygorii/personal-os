import http from 'http';
import crypto from 'crypto';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { col, rawCol, getProfile, logEvent } from './db.js';
import { config } from './config.js';
import { chat } from './llm.js';
import { sendPings } from './telegram.js';
import * as system from './system.js';
import * as users from './users.js';
import { runAs, uid, personName, languageRule } from './ctx.js';
import { verifyTelegramLogin, createSession, readSession, parseCookies, sessionCookie, clearedCookie } from './auth.js';

// Read a small JSON request body (exam answers etc.). Hard 200KB cap.
function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 200000) req.destroy();
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
  '/hub': { file: '../webapp/home.html' },
  '/home': { file: '../webapp/home.html' },
  '/deck': { file: '../english/study.html', homeBar: true },
  '/body': { file: '../body/map.html', homeBar: true },
  '/reading': { file: '../reading/journal.html', homeBar: true },
  '/routine': { file: '../routines/today.html', homeBar: true },
  '/dashboard': { file: '../webapp/dashboard.html' },
};

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
async function gatherBookRecs(refresh) {
  const DAY = 86400000;
  // meta is a global collection, so this cache key must carry the user itself.
  const cacheId = `book_recs:${uid()}`;
  const cached = await col('meta').findOne({ _id: cacheId });
  const fresh = cached?.ts && Date.now() - new Date(cached.ts).getTime() < 7 * DAY;
  if (cached?.recs?.length && fresh && !refresh) return { recs: cached.recs, at: cached.ts };

  const [profile, bookLogs, engBooks, current] = await Promise.all([
    getProfile(),
    col('logs').find({ type: 'book' }).sort({ ts: -1 }).limit(20).toArray(),
    col('english_books').find().sort({ lastDiscussed: -1 }).limit(10).toArray(),
    col('reading').findOne({ _id: 'current' }),
  ]);
  const history =
    [...new Set([...bookLogs.map((b) => b.title), ...engBooks.map((b) => b.title), current?.title].filter(Boolean))].join('; ') ||
    'nothing logged yet';

  const sys = `${languageRule()}
You are ${personName()}'s reading advisor and you know them well. Recommend exactly 4 books they have NOT read, each chosen FOR THEM:
- one that advances his mission (Collections × AI — becoming the professional companies hunt),
- one on finance/risk/decision-making matching his taste (Taleb, Marks, Housel — substantive, multi-perspective),
- one for the builder/founder in him (SILKILINEN),
- one wildcard from his wider interests (history, systems thinking, psychology).
"why" must be ONE sharp sentence (max 160 chars) tied to HIS goals — never a blurb.

WHO HE IS: ${JSON.stringify({ mission: profile.mission, goals: profile.goals, readingTaste: profile.readingTaste, interests: profile.interests })}
ALREADY READ / IN PROGRESS (never recommend these): ${history}

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
    throw new Error('no recommendations generated');
  }
  recs = recs.slice(0, 4).map((r) => ({ title: String(r.title || ''), author: String(r.author || ''), why: String(r.why || '') }));
  await col('meta').updateOne({ _id: cacheId }, { $set: { ts: new Date(), recs } }, { upsert: true });
  return { recs, at: new Date() };
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
    exam: b.exam ? { score: Number(b.exam.score) || 0, ts: Number(b.exam.ts) || Date.now(), verdict: String(b.exam.verdict || '').slice(0, 600) } : null,
    started: Number(b.started) || Date.now(),
    updated: Number(b.updated) || Date.now(),
  }));
  await col('books').updateOne({ _id: 'library' }, { $set: { books: clean, updatedAt: new Date() } }, { upsert: true });
  return { ok: true, count: clean.length };
}

// ---- Sharing: a result that travels beyond Telegram ----
// A public page per shared result, so it opens on WhatsApp, X, LinkedIn, Reddit — anywhere
// a link goes — carrying a deep link back into the bot. Only what they chose to share is
// published: the book, the score, and optionally one thought. Never their library.
const shareCode = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

async function createShare({ title, author, score, verdict, thought, name }) {
  const code = shareCode();
  await rawCol('shares').insertOne({
    _id: code,
    userId: uid(),
    title: String(title || '').slice(0, 300),
    author: String(author || '').slice(0, 200),
    score: score == null ? null : Math.max(0, Math.min(100, Number(score) || 0)),
    verdict: String(verdict || '').slice(0, 400),
    thought: String(thought || '').slice(0, 500),
    name: String(name || '').slice(0, 60),
    createdAt: new Date(),
    views: 0,
  });
  const url = `${config.appUrl}/r/${code}`;
  return { code, url, deepLink: `https://t.me/${config.botUsername || 'bot'}?start=r_${code}` };
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The card, drawn as SVG — downloadable for Instagram/X where a link alone won't travel.
function shareCard(s) {
  const score = s.score == null ? '—' : `${s.score}%`;
  const title = s.title.length > 34 ? s.title.slice(0, 33) + '…' : s.title;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#14130F"/>
  <rect x="0" y="0" width="1200" height="8" fill="#D9AE4A"/>
  <text x="80" y="130" fill="#9C9686" font-family="Georgia,serif" font-size="30">${esc(s.name || 'A reader')} was tested on</text>
  <text x="80" y="230" fill="#ECE8DF" font-family="Georgia,serif" font-size="68" font-weight="bold">${esc(title)}</text>
  ${s.author ? `<text x="80" y="285" fill="#9C9686" font-family="Georgia,serif" font-size="32">${esc(s.author)}</text>` : ''}
  <text x="80" y="440" fill="#D9AE4A" font-family="Georgia,serif" font-size="150" font-weight="bold">${score}</text>
  <text x="80" y="495" fill="#9C9686" font-family="Georgia,serif" font-size="28">honest comprehension score</text>
  <text x="80" y="575" fill="#ECE8DF" font-family="Georgia,serif" font-size="30">Most people forget what they read. Find out if you did.</text>
</svg>`;
}

function sharePage(s) {
  const score = s.score == null ? '' : `${s.score}%`;
  const desc = `${s.score != null ? `Scored ${s.score}% ` : ''}on an honest comprehension test of "${s.title}". Most people forget what they read — find out if you did.`;
  const deep = `https://t.me/${config.botUsername || 'bot'}?start=r_${s._id}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(s.name || 'A reader')} — ${esc(s.title)}${score ? ` · ${score}` : ''}</title>
<meta property="og:title" content="${esc(s.name || 'A reader')} scored ${score} on &quot;${esc(s.title)}&quot;">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${config.appUrl}/r/${s._id}/card.svg">
<meta property="og:url" content="${config.appUrl}/r/${s._id}"><meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(s.name || 'A reader')} scored ${score} on &quot;${esc(s.title)}&quot;">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${config.appUrl}/r/${s._id}/card.svg">
<style>
 :root{color-scheme:dark}
 *{box-sizing:border-box} body{margin:0;background:#14130F;color:#ECE8DF;
   font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.6;
   display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
 .card{max-width:520px;width:100%;background:#1D1B16;border:1px solid #2C2A22;border-radius:20px;padding:34px 30px;text-align:center}
 .kicker{color:#D9AE4A;font-size:.78rem;letter-spacing:.16em;text-transform:uppercase;font-weight:600}
 h1{font-family:Georgia,serif;font-size:1.9rem;margin:.5rem 0 .2rem;line-height:1.2}
 .author{color:#9C9686;margin:0 0 20px}
 .score{font-family:Georgia,serif;font-size:5rem;font-weight:700;color:#D9AE4A;line-height:1;margin:14px 0 2px}
 .slabel{color:#9C9686;font-size:.85rem;text-transform:uppercase;letter-spacing:.08em}
 .verdict{background:#26241D;border-radius:12px;padding:14px 16px;margin:22px 0;font-size:.95rem;text-align:left}
 .thought{border-left:3px solid #D9AE4A;padding-left:14px;margin:18px 0;text-align:left;font-style:italic;color:#C9C3B6}
 .pitch{margin:26px 0 18px;font-size:1.02rem}
 a.cta{display:block;background:#D9AE4A;color:#14130F;text-decoration:none;font-weight:700;
   padding:15px;border-radius:12px;font-size:1.05rem}
 .foot{color:#6E695C;font-size:.78rem;margin-top:16px}
</style></head><body>
<div class="card">
  <div class="kicker">Honest comprehension test</div>
  <h1>${esc(s.title)}</h1>
  ${s.author ? `<p class="author">${esc(s.author)}</p>` : ''}
  ${s.score != null ? `<div class="score">${s.score}%</div><div class="slabel">${esc(s.name || 'A reader')}'s score</div>` : ''}
  ${s.verdict ? `<div class="verdict">${esc(s.verdict)}</div>` : ''}
  ${s.thought ? `<div class="thought">"${esc(s.thought)}"</div>` : ''}
  <p class="pitch">You forget most of what you read.<br><b>Find out if you did.</b></p>
  <a class="cta" href="${deep}">📕 Test me on a book →</a>
  <div class="foot">Read it. Prove you kept it.</div>
</div></body></html>`;
}

// ---- Book knowledge exam: honest questions, honest grading ----
// Generate: 5 questions that test real understanding of THIS book — comprehension,
// application to HIS life/mission, and one pushback. Grade: radical honesty (his standing
// order) — vague answers score low, with the weak spot named. Results feed Mind XP.
async function generateExam({ title, author }) {
  if (!title) throw new Error('no title');
  const profile = await getProfile();
  const sys = `${languageRule()}
You are ${personName()}'s reading examiner. Write an exam for the book "${title}"${author ? ` by ${author}` : ''} that tests whether they ACTUALLY understood and can USE it — not trivia.
Exactly 5 questions, each answerable in 2-4 sentences:
- Q1-Q2: the book's core ideas (comprehension — could he explain them to a colleague?)
- Q3-Q4: application to HIS real life and mission (${profile.mission || 'his growth'}) — make him use the idea, not recite it
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
  const list = exam.questions.map((q, i) => `Q${i + 1}: ${q}\nHIS ANSWER: ${String((answers || [])[i] || '(no answer)')}`).join('\n\n');
  const sys = `${languageRule()}
You are grading ${personName()}'s exam on "${exam.title}". The standing order is radical honesty: real scores, never inflated, never cruel — precise. A vague, generic, or bluffed answer scores under 40. A solid answer with the book's actual idea scores 60-80. Genuine insight applied to their own life scores higher. For each answer: a 0-100 score and ONE sharp sentence of feedback (name the weak spot or what landed). Then an overall 0-100 (weighted judgment, not just the average) and a one-sentence verdict they'd thank you for.
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
    '<script src="https://telegram.org/js/telegram-web-app.js"></script>' +
    '<style>*{box-sizing:border-box}html,body{margin:0}</style></head><body>' +
    bar + fragment +
    '<script>try{var t=window.Telegram&&window.Telegram.WebApp;if(t){t.ready();t.expand();}}catch(e){}</script>' +
    '</body></html>'
  );
}

export function startServer(port = process.env.PORT || 8080) {
  const server = http.createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    // ---- signing in on the website ----
    // Telegram redirects here after the Login Widget. Verify, create the account if it's
    // their first time, set a session cookie, and drop them into the app.
    if (path === '/auth/telegram') {
      const q = Object.fromEntries(new URL(req.url, `https://${req.headers.host}`).searchParams);
      const tgUser = verifyTelegramLogin(q);
      if (!tgUser) {
        res.writeHead(302, { Location: '/app?error=login' });
        res.end();
        return;
      }
      const acct = await users.ensureUser({ chatId: tgUser.id, name: tgUser.first_name, username: tgUser.username });
      if (!users.isAllowed(acct)) {
        res.writeHead(302, { Location: '/app?error=waiting' });
        res.end();
        return;
      }
      res.writeHead(302, { Location: '/app', 'Set-Cookie': sessionCookie(createSession(acct._id)) });
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
    if (path === '/app') {
      const sid = readSession(parseCookies(req.headers.cookie).kept_session);
      const file = sid ? '../reading/journal.html' : '../webapp/signin.html';
      try {
        let html = await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
        html = html
          .replaceAll('BOT_USERNAME', config.botUsername || 'grisha_steward_bot')
          .replaceAll('BOT_LINK', `https://t.me/${config.botUsername || 'grisha_steward_bot'}`)
          .replaceAll('APP_URL', config.appUrl);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(wrap(html, false));
      } catch (err) {
        console.error('[web] /app failed:', err.message);
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
      path === '/api/share'
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
      try {
        // Everything inside runAs reads and writes only this user's data.
        // /api/words: the LIVE word bank — words the tutor caught them missing in chat
        // plus the curriculum words synced from english/words.md. Chat-caught first.
        const needsBody =
          path === '/api/bookexam' || path === '/api/bookexam/grade' || path === '/api/share' ||
          (path === '/api/books' && req.method === 'PUT');
        const body = needsBody ? await readJson(req) : null;
        const data = await runAs(acct, async () => {
          if (path === '/api/books') return req.method === 'PUT' ? saveBooks(body?.books) : getBooks();
          if (path === '/api/share') return createShare({ ...body, name: body?.name || acct.name });
          if (path === '/api/words') {
            const rows = await col('english_words')
              .find()
              .sort({ source: 1, lastSeen: -1 }) // 'chat' < 'curriculum' alphabetically
              .limit(200)
              .toArray();
            return rows.map((r) => ({ word: r.word, note: r.why || r.note || '', count: r.count || 1, source: r.source || 'chat' }));
          }
          if (path === '/api/bookrecs') return gatherBookRecs(/[?&]refresh=1/.test(req.url || ''));
          if (path === '/api/bookexam') return generateExam(body);
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
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
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
    try {
      const abs = fileURLToPath(new URL(route.file, import.meta.url));
      let fragment = await readFile(abs, 'utf8');
      // The landing page is served to strangers, so its call-to-action must point at the
      // real bot — resolved at request time from the username discovered at boot.
      if (route.public) {
        fragment = fragment
          .replaceAll('BOT_LINK', `https://t.me/${config.botUsername || 'grisha_steward_bot'}`)
          .replaceAll('APP_URL', config.appUrl);
      }
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
