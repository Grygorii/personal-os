import { chat } from './llm.js';
import { getProfile, col, logEvent } from './db.js';
import { send, sendPings } from './telegram.js';
import { config } from './config.js';
import * as system from './system.js';

// ---------- context gathering ----------

async function recentLogs(days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return col('logs').find({ ts: { $gte: since } }).sort({ ts: 1 }).toArray();
}

async function getReading() {
  return col('reading').findOne({ _id: 'current' });
}

async function recentConversation(limit = 16) {
  const rows = await col('conversation').find().sort({ ts: -1 }).limit(limit).toArray();
  return rows.reverse();
}

async function remember(role, text) {
  await col('conversation').insertOne({ role, text, ts: new Date() });
}

function summarizeLogs(logs) {
  if (!logs.length) return 'Nothing logged yet.';
  const byDay = {};
  for (const l of logs) {
    const day = new Date(l.ts).toISOString().slice(0, 10);
    (byDay[day] ||= []);
    if (l.type === 'water') byDay[day].push(`water ${l.value}L`);
    else if (l.type === 'sleep') byDay[day].push(`sleep ${l.asleep || '?'}–${l.awake || '?'}${l.hours ? ` (${l.hours}h)` : ''}`);
    else if (l.type === 'book') byDay[day].push(`book: ${l.title} ${l.event}`);
    else if (l.type === 'essay') byDay[day].push(`wrote an essay on ${l.book || 'a book'}`);
    else if (l.type === 'note') byDay[day].push(`note: ${l.text}`);
    else byDay[day].push(l.type);
  }
  return Object.entries(byDay).map(([d, items]) => `${d}: ${items.join(', ')}`).join('\n');
}

// ---------- the coach's mind ----------

function buildSystem({ profile, logsSummary, reading, energy, now }) {
  const readingLine = reading
    ? `${reading.title}${reading.author ? ' by ' + reading.author : ''} — status: ${reading.status || 'reading'}${reading.progress ? `, progress: ${reading.progress}` : ''}`
    : 'nothing right now';

  const e = energy || {};
  const sleepTxt = e.sleepHours != null ? `${e.sleepHours}h` : 'unknown';
  const activeEffects =
    [...(e.effects?.debuffs || []), ...(e.effects?.buffs || [])].map((x) => x.label).join('; ') || 'none';

  return `You are Гриша's personal coach. Not an app, not a logging tool — a coach who knows him and is genuinely in his corner.

WHO HE IS:
${JSON.stringify(profile, null, 2)}

HOW YOU COACH — read the situation every single time:
You have no fixed style. Each message, sense what's happening from what he says, how he says it, and his recent data, then choose your register: push him, encourage him, ask a question that makes him think, celebrate a win, or just listen and step back. Be tough when he needs a spine, warm when he's low, curious when he's stuck, quiet when he's flowing. Never default to one tone. Read his mood across days, not just this message — if a low patch is forming, name it gently and ask what's behind it. When he's stuck, prefer a question that leads him to his own answer over handing him yours.

YOUR CORE PRINCIPLE — autonomy, never authority:
Your job is for him to *want* to do the thing — never to feel bossed or pushed. Tie everything to HIS own goals and reasons, not your demands. If he resists, don't push harder — get curious about why. Progress should feel self-chosen. He should never feel a boss standing over him. The real win is when he moves because he wants to and barely notices you nudged.

STYLE:
- Telegram messages: short and human — a sentence to three. No essays, no bullet lists, no corporate-wellness voice.
- Honest over flattering. He'd rather hear the truth, warmly.
- Use his data naturally — notice patterns, reference yesterday, hold continuity — but never recite stats at him like a dashboard.
- One thread at a time. Don't pile on.

WHEN HE SHARES SOMETHING worth remembering (water, sleep, what he's reading, progress, a thought), capture it as an action AND respond as a coach. Never reply with just "Logged."

CONTEXT RIGHT NOW:
Local time: ${now}
Currently reading: ${readingLine}
Activity, last 7 days:
${logsSummary}

ENERGY & CONSEQUENCES — speak to how he'll actually feel, never the raw numbers:
Energy right now: ${e.energy ?? '?'}/100. Foundation — last sleep: ${sleepTxt}; water today: ${e.todayWater ?? 0}L; water yesterday: ${e.yesterdayWater ?? 0}L.
Active status effects: ${activeEffects}. (Debuffs reflect real strain, buffs reward good days. If a debuff is active, you can name the symptom he's likely feeling — as foresight, not a verdict.)
When these run low, connect them to lived consequence — a flat stretch in the afternoon, foggy focus, less drive for deep SILKILINEN work — as foresight he'd thank you for, never a scold, and only when it genuinely matters. Don't recite the figures back at him; translate them into what today will feel like. When they're solid, let it ride.

OUTPUT FORMAT — reply with ONLY a JSON object, nothing else, no markdown fences:
{
  "reply": "your message to him",
  "actions": []
}
Available actions (include only what he clearly supports — never invent data):
- {"type":"log_water","litres":0.5}
- {"type":"log_sleep","asleep":"23:30","awake":"07:00","hours":7.5}
- {"type":"set_reading","title":"...","author":"...","status":"reading"}
- {"type":"log_progress","note":"halfway, chapter 8"}
- {"type":"finish_book"}
- {"type":"log_essay","book":"...","essay":"...","feedback":"..."}
- {"type":"log_work","note":"shipped the checkout fix"}
- {"type":"log_note","text":"something he said worth remembering"}
"actions" can be empty.`;
}

function parseResponse(raw) {
  let txt = raw.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```$/, '')
    .trim();
  try {
    const o = JSON.parse(txt);
    return { reply: o.reply || '…', actions: Array.isArray(o.actions) ? o.actions : [] };
  } catch {
    // If the model didn't return clean JSON, just use its text as the reply.
    return { reply: raw, actions: [] };
  }
}

async function think(finalUserContent) {
  const [profile, logs, reading, history, energy] = await Promise.all([
    getProfile(),
    recentLogs(),
    getReading(),
    recentConversation(),
    system.energySnapshot(),
  ]);

  const systemPrompt = buildSystem({
    profile,
    logsSummary: summarizeLogs(logs),
    reading,
    energy,
    now: new Date().toLocaleString('en-IE', { timeZone: config.timezone }),
  });

  const messages = history.map((m) => ({
    role: m.role === 'coach' ? 'assistant' : 'user',
    content: m.text,
  }));
  messages.push({ role: 'user', content: finalUserContent });

  const raw = await chat({ system: systemPrompt, messages, maxTokens: 600 });
  return parseResponse(raw);
}

// ---------- acting on what he said ----------

async function applyAction(a) {
  switch (a.type) {
    case 'log_water':
      await logEvent('water', { value: Number(a.litres) || 0 });
      break;
    case 'log_sleep':
      await logEvent('sleep', { asleep: a.asleep, awake: a.awake, hours: a.hours });
      break;
    case 'set_reading':
      await col('reading').updateOne(
        { _id: 'current' },
        { $set: { title: a.title, author: a.author || '', status: a.status || 'reading', updatedAt: new Date() } },
        { upsert: true }
      );
      await logEvent('book', { title: a.title, event: 'started' });
      break;
    case 'log_progress':
      await col('reading').updateOne(
        { _id: 'current' },
        { $set: { progress: a.note, updatedAt: new Date() } }
      );
      break;
    case 'finish_book': {
      const r = await getReading();
      if (r) {
        await logEvent('book', { title: r.title, event: 'finished' });
        await col('reading').updateOne({ _id: 'current' }, { $set: { status: 'finished' } });
      }
      break;
    }
    case 'log_note':
      await logEvent('note', { text: a.text });
      break;
    case 'log_essay':
      await logEvent('essay', { book: a.book, question: a.question, essay: a.essay, feedback: a.feedback });
      break;
    case 'log_work':
      await logEvent('work', { note: a.note });
      break;
    default:
      console.warn('[coach] unknown action:', a.type);
  }
}

async function deliver({ reply, actions }) {
  const pings = [];
  for (const a of actions) {
    try {
      await applyAction(a);
      const p = await system.recordAction(a);
      pings.push(...p);
    } catch (e) {
      console.error('[coach] action failed:', e.message);
    }
  }
  await remember('coach', reply);
  await send(reply);
  await sendPings(pings);
}

// ---------- entry points ----------

// Any free-text message from him.
export async function handle(userText) {
  await remember('user', userText);
  await deliver(await think(userText));
}

// Proactive check-in fired by the scheduler.
export async function checkIn(kind) {
  const trigger =
    kind === 'morning'
      ? "(Morning check-in — he hasn't messaged. Open his day the way a coach who's read the room would, based on his data and goals. Short.)"
      : "(Evening check-in — he hasn't messaged. Look back on his day from the data and reach out: notice what happened, hold gentle continuity. Short.)";
  await deliver(await think(trigger));
}
