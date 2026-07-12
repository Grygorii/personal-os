import { chat } from '../llm.js';
import { col, logEvent } from '../db.js';
import { send, sendPings, sendButtons } from '../telegram.js';
import * as system from '../system.js';

// The English → C2 tutor. A dedicated conversation mode: Гриша talks (business,
// psychology, life) and every message is scored honestly, mined for gaps, and logged.
// Runtime state lives in Mongo (Railway's filesystem is ephemeral); the english/*.md
// files are the Claude Code curriculum, not runtime state.

const DECK_URL = 'https://claude.ai/code/artifact/b8abb83b-6e0f-42a8-8946-b7a2e5448b3f';
const DIMS = ['clarity', 'grammar', 'vocab', 'concise', 'register'];

// ---------- state ----------
async function getState() {
  return (await col('english').findOne({ _id: 'state' })) || { _id: 'state', mode: false, level: 'B1–B2', sessionCount: 0 };
}
async function setState(patch) {
  await col('english').updateOne({ _id: 'state' }, { $set: patch }, { upsert: true });
}
export async function isActive() {
  const s = await col('english').findOne({ _id: 'state' }, { projection: { mode: 1 } });
  return !!(s && s.mode);
}

// ---------- conversation memory (kept separate from the coach's) ----------
async function remember(role, text) {
  await col('english_convo').insertOne({ role, text, ts: new Date() });
}
async function history(limit = 16) {
  const rows = await col('english_convo').find().sort({ ts: -1 }).limit(limit).toArray();
  return rows.reverse();
}

// ---------- the tutor's mind ----------
export function buildSystem(state, recent) {
  const recentLine = recent.length
    ? recent.map((r) => `${new Date(r.ts).toISOString().slice(0, 10)}: avg ${r.avg?.toFixed?.(1) ?? '?'} (${r.level_estimate || '?'})`).join(' · ')
    : 'no scored conversations yet';

  return `You are Гриша's English tutor, aiming him at Cambridge C2 — and, bigger, at becoming the professional companies chase and a founder. English is one brick in that.

YOUR STANDING ORDER — RADICAL HONESTY (he set this himself, permanently):
This is his safe space to hear the truth the corporate world withholds (outside, people stay silent and quietly decide "not ready"). So:
- Tell him his REAL level even when it's below his hopes ("that reads B1, not C2").
- Name thin ideas, undone work, and knowledge holes directly — don't hint.
- Never flatter, never soften to protect feelings, never cave to pushback or emotion.
- Straight = PRECISE and growth-serving, not cruelty. Exact truth beats vague harshness.

HOW YOU WORK:
- You TALK WITH HIM in English about real things — business, psychology, life (immersion). Short and human on Telegram (1–4 sentences), but sharp.
- DRIVE HIM — no mercy (his explicit order). He wants the conversational level of someone the best global companies chase. So NEVER settle for a shallow exchange or one soft question: challenge vague or lazy answers, demand specifics and evidence, raise the difficulty as he keeps up, and pull him toward executive/founder-level articulation. A one-line answer from him is NOT an answer — press for the real one. Concise in words, relentless in depth. Lead the conversation upward; don't just react.
- Do NOT print a scorecard. Converse. Only correct him INLINE when a normal, non-patient listener would misunderstand him, or a clear gap shows — point at the EXACT spot, briefly, then keep driving. Over-understanding him hides his gaps; be the average listener.
- When you introduce or correct a WORD, ALWAYS spell it out letter by letter (holistic → h-o-l-i-s-t-i-c) and give its pronunciation (CAPS for the stressed part, e.g. NEW-ahnss). He struggles with spelling and wants the letters every time — not optional.
- His NORTH STAR: be understood by anyone, first time, zero effort. Verbosity ("ten words for one") and vague words are failures even when "correct".

SILENTLY assess EVERY message of his on five 1–5 scores — be honest, low is low:
- clarity (would an average listener get it first time?), grammar, vocab (precision + range), concise (one sharp sentence, not ten padded), register (professional tone).
Also read his true CEFR level for THIS message (A2/B1/B2/C1/C2).

MINE from his message: words he reached for but couldn't produce (missing_words); spots he used ten words for one (verbose: said→tight); grammar gaps; breakdowns where meaning ACTUALLY failed (said, why, the clear version). If he discusses a BOOK, capture its title, one key idea he showed, and how well he ACTUALLY understood it (comprehension 1–5 from what he demonstrates, not from him claiming he read it).

CONTEXT: level so far: ${state.level}. Recent conversations: ${recentLine}.

OUTPUT — reply with ONLY a JSON object, no markdown fences, nothing else:
{
  "reply": "your message to him (English, short, honest)",
  "scores": {"clarity":3,"grammar":3,"vocab":3,"concise":3,"register":3},
  "level_estimate": "B1",
  "topic": "what you talked about, a few words",
  "missing_words": [{"word":"leverage","why":"reached for it, said 'use the power of'"}],
  "verbose": [{"said":"the reason why I did it is because","tight":"because"}],
  "grammar_gaps": ["comma splice"],
  "breakdowns": [{"said":"...","why":"...","clear":"..."}],
  "book": {"title":"...","idea":"...","comprehension":3},
  "depth": "light|solid|deep"
}
Every array empty when there's nothing. "book" null unless he genuinely discussed one. Score honestly — a weak message gets low numbers.`;
}

// Reuse the coach's tolerant JSON extraction so a wrapped object is never dropped.
function parse(raw) {
  const clean = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
  const tryParse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  let o = tryParse(clean);
  if (!o) { const m = clean.match(/\{[\s\S]*\}/); if (m) o = tryParse(m[0]); }
  if (!o) return { reply: raw, scores: {}, missing_words: [], verbose: [], grammar_gaps: [], breakdowns: [], book: null };
  return {
    reply: o.reply || '…',
    scores: o.scores && typeof o.scores === 'object' ? o.scores : {},
    level_estimate: o.level_estimate || null,
    topic: o.topic || null,
    missing_words: Array.isArray(o.missing_words) ? o.missing_words : [],
    verbose: Array.isArray(o.verbose) ? o.verbose : [],
    grammar_gaps: Array.isArray(o.grammar_gaps) ? o.grammar_gaps : [],
    breakdowns: Array.isArray(o.breakdowns) ? o.breakdowns : [],
    book: o.book && o.book.title ? o.book : null,
    depth: o.depth || 'solid',
  };
}

export function avgScore(scores) {
  const vals = DIMS.map((k) => Number(scores[k])).filter((n) => !Number.isNaN(n));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

async function think(userText) {
  const [state, hist, recent] = await Promise.all([
    getState(),
    history(),
    col('english_scores').find().sort({ ts: -1 }).limit(5).toArray(),
  ]);
  const sys = buildSystem(state, recent.reverse());
  const messages = hist.map((m) => ({ role: m.role === 'tutor' ? 'assistant' : 'user', content: m.text }));
  messages.push({ role: 'user', content: userText });
  const raw = await chat({ system: sys, messages, maxTokens: 800 });
  const parsed = parse(raw);
  console.log(`[english] in="${userText.slice(0, 60).replace(/\n/g, ' ')}" avg=${avgScore(parsed.scores)?.toFixed?.(1) ?? '?'} lvl=${parsed.level_estimate}`);
  return parsed;
}

// ---------- persistence + scoring ----------
async function persist(p) {
  const now = new Date();
  const avg = avgScore(p.scores);

  await col('english_scores').insertOne({
    ts: now, scores: p.scores, avg, level_estimate: p.level_estimate,
    topic: p.topic, verbose: p.verbose, grammar_gaps: p.grammar_gaps,
  });

  for (const w of p.missing_words) {
    const word = (w.word || '').toLowerCase().trim();
    if (!word) continue;
    await col('english_words').updateOne(
      { word },
      { $setOnInsert: { word, createdAt: now }, $set: { why: w.why || '', lastSeen: now }, $inc: { count: 1 } },
      { upsert: true }
    );
  }

  for (const b of p.breakdowns) {
    if (!b || !b.said) continue;
    await col('english_breakdowns').insertOne({ said: b.said, why: b.why || '', clear: b.clear || '', ts: now });
  }

  if (p.book) {
    const key = p.book.title.toLowerCase().trim();
    await col('english_books').updateOne(
      { key },
      {
        $setOnInsert: { key, title: p.book.title, createdAt: now },
        $set: { lastDiscussed: now, comprehension: p.book.comprehension ?? null },
        ...(p.book.idea ? { $push: { ideas: { $each: [p.book.idea], $slice: -30 } } } : {}),
      },
      { upsert: true }
    );
  }

  // Feed the life-System: log it into the stream (so it counts toward Mind, the daily
  // think-quest, breadth and streak) and award honest Mind XP (weak session = little).
  await logEvent('english', { avg, level: p.level_estimate, depth: p.depth });
  const pings = await system.recordAction({ type: 'log_english', scores: p.scores, depth: p.depth });
  return pings;
}

// ---------- entry points ----------
export async function enter() {
  const s = await getState();
  await setState({ mode: true, sessionCount: (s.sessionCount || 0) + 1, updatedAt: new Date() });
  await send(
    '🎧 *English mode — on.*\n\n' +
      "Let's just talk, in English — your business idea, something you're chewing on, your day. " +
      "I'll talk back and quietly score you (honestly — it can go down). I'll only stop you when a normal " +
      'person would lose your meaning.\n\n' +
      'What do you want to get into? `/done` when you want to stop.'
  );
}

export async function exit() {
  await setState({ mode: false, updatedAt: new Date() });
  const last = await col('english_scores').findOne({}, { sort: { ts: -1 } });
  const tail = last?.avg != null
    ? ` Last read: ${last.avg.toFixed(1)}/5 (${last.level_estimate || '?'}).`
    : '';
  await send(`English mode — off.${tail} Type \`/englishreport\` any time to see the honest trend, or \`/english\` to go again.`);
}

export async function handle(userText) {
  await remember('user', userText);
  const parsed = await think(userText);
  const pings = await persist(parsed);
  await remember('tutor', parsed.reply);
  await send(parsed.reply);
  await sendPings(pings);
}

// ---------- report: the honest trend ----------
function arrow(cur, prev) {
  if (cur == null || prev == null) return ' ';
  if (cur > prev + 0.15) return '▲';
  if (cur < prev - 0.15) return '▼';
  return '=';
}

export async function report() {
  const rows = await col('english_scores').find().sort({ ts: 1 }).toArray();
  if (!rows.length) {
    await send('No English conversations scored yet. Start with `/english` and just talk.');
    return;
  }
  const dimAvg = (list, k) => {
    const v = list.map((r) => Number(r.scores?.[k])).filter((n) => !Number.isNaN(n));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const half = Math.max(1, Math.floor(rows.length / 2));
  const older = rows.slice(0, half);
  const newer = rows.slice(-half);

  const out = ['⟦  E N G L I S H  —  H O N E S T  T R E N D  ⟧', `${rows.length} conversations scored`, ''];
  for (const k of DIMS) {
    const now = dimAvg(newer, k);
    const was = rows.length > 1 ? dimAvg(older, k) : null;
    out.push(`${k.padEnd(9)}${(now == null ? '—' : now.toFixed(1)).padEnd(6)}${arrow(now, was)}${was != null ? `  (was ${was.toFixed(1)})` : ''}`);
  }
  const lvl = newer.map((r) => r.level_estimate).filter(Boolean);
  out.push('');
  out.push(`Recent level reads: ${lvl.slice(-5).join(', ') || '—'}`);

  const words = await col('english_words').find().sort({ count: -1, lastSeen: -1 }).limit(8).toArray();
  if (words.length) out.push('', 'Words you keep missing: ' + words.map((w) => w.word).join(', '));

  await send('```\n' + out.join('\n') + '\n```');
}

// ---------- the book library ----------
export async function library() {
  const rows = await col('english_books').find().sort({ lastDiscussed: -1 }).toArray();
  if (!rows.length) {
    await send('📚 Your library is empty. Talk about a book in English mode, or add one with `/book <title>`, and I\'ll track how well you actually absorbed it.');
    return;
  }
  const out = ['⟦  Y O U R   L I B R A R Y  ⟧', ''];
  for (const b of rows) {
    const c = b.comprehension != null ? `${b.comprehension}/5` : 'not yet tested';
    const advise = b.comprehension != null && b.comprehension <= 2 ? '  ← worth a re-read' : '';
    out.push(`${b.title} — grasp ${c}${advise}`);
    if (b.ideas?.length) out.push(`   · ${b.ideas.slice(-2).join(' / ')}`);
  }
  await send('```\n' + out.join('\n') + '\n```');
}

export async function addBook(title) {
  const key = title.toLowerCase().trim();
  await col('english_books').updateOne(
    { key },
    { $setOnInsert: { key, title, createdAt: new Date(), ideas: [] }, $set: { lastDiscussed: new Date() } },
    { upsert: true }
  );
  await send(`📚 Added *${title}* to your library. Tell me about it in English mode and I'll score how well you actually got it.`);
}

async function deck() {
  await sendButtons(
    '📖 *Your study deck* — meaning cards (tap any word you don\'t know), spelling, grammar, ' +
      'and pronunciation with audio. Tap to open inside Telegram:',
    [{ text: 'Open study deck', url: DECK_URL }]
  );
}

// ---------- command router hook ----------
// Returns true if it handled the message.
export async function command(text) {
  if (/^\/english\b/i.test(text)) { await enter(); return true; }
  if (/^\/(done|endenglish|stop)\b/i.test(text)) { await exit(); return true; }
  if (/^\/englishreport\b/i.test(text)) { await report(); return true; }
  if (/^\/library\b/i.test(text)) { await library(); return true; }
  if (/^\/deck\b/i.test(text)) { await deck(); return true; }
  const m = text.match(/^\/book\s+(.+)/i);
  if (m) { await addBook(m[1].trim()); return true; }
  return false;
}
