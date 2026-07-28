import http from 'http';
import crypto from 'crypto';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { col, getProfile, logEvent } from './db.js';
import { config } from './config.js';
import { chat } from './llm.js';
import { sendPings } from './telegram.js';
import * as system from './system.js';

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
  '/': { file: '../webapp/home.html' },
  '/app': { file: '../webapp/home.html' },
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
  const cached = await col('meta').findOne({ _id: 'book_recs' });
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

  const sys = `You are Гриша's reading advisor and you know him well. Recommend exactly 4 books he has NOT read, each chosen FOR HIM:
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
  await col('meta').updateOne({ _id: 'book_recs' }, { $set: { ts: new Date(), recs } }, { upsert: true });
  return { recs, at: new Date() };
}

// ---- Book knowledge exam: honest questions, honest grading ----
// Generate: 5 questions that test real understanding of THIS book — comprehension,
// application to HIS life/mission, and one pushback. Grade: radical honesty (his standing
// order) — vague answers score low, with the weak spot named. Results feed Mind XP.
async function generateExam({ title, author }) {
  if (!title) throw new Error('no title');
  const profile = await getProfile();
  const sys = `You are Гриша's reading examiner. Write an exam for the book "${title}"${author ? ` by ${author}` : ''} that tests whether he ACTUALLY understood and can USE it — not trivia.
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
  const sys = `You are grading Гриша's exam on "${exam.title}". His STANDING ORDER is radical honesty: real scores, never inflated, never cruel — precise. A vague, generic, or bluffed answer scores under 40. A solid answer with the book's actual idea scores 60-80. Genuine insight applied to his own life scores higher. For each answer: a 0-100 score and ONE sharp sentence of feedback (name the weak spot or what landed). Then an overall 0-100 (weighted judgment, not just the average) and a one-sentence verdict he'd thank you for.
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
    if (path === '/api/dashboard' || path === '/api/words' || path === '/api/bookrecs' || path === '/api/bookexam' || path === '/api/bookexam/grade') {
      const user = verifyInitData(req.headers['x-telegram-init-data'] || '', config.telegramToken);
      if (!user || String(user.id) !== String(config.telegramChatId)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      try {
        // /api/words: the LIVE word bank — words the tutor caught him missing in chat
        // (english_words, written by the english agent) plus the curriculum words synced
        // from english/words.md on boot. Chat-caught first, newest first, so the deck
        // grows visibly the moment a conversation surfaces a gap.
        let data;
        if (path === '/api/words') {
          data = await col('english_words')
            .find()
            .sort({ source: 1, lastSeen: -1 }) // 'chat' < 'curriculum' alphabetically
            .limit(200)
            .toArray()
            .then((rows) =>
              rows.map((r) => ({ word: r.word, note: r.why || r.note || '', count: r.count || 1, source: r.source || 'chat' }))
            );
        } else if (path === '/api/bookrecs') {
          data = await gatherBookRecs(/[?&]refresh=1/.test(req.url || ''));
        } else if (path === '/api/bookexam') {
          data = await generateExam(await readJson(req));
        } else if (path === '/api/bookexam/grade') {
          data = await gradeExam(await readJson(req));
        } else {
          data = await gatherDashboard();
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      } catch (err) {
        console.error('[web] api error:', path, err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'server' }));
      }
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
      const fragment = await readFile(abs, 'utf8');
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
