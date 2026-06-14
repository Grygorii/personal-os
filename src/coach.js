import { chat } from './llm.js';
import { getProfile, col, logEvent, recentCount } from './db.js';
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
    else if (l.type === 'skill') byDay[day].push(`coach suggested skill: ${l.skill}`);
    else if (l.type === 'work') byDay[day].push(`shipped: ${l.note || 'work'}`);
    else if (l.type === 'move') byDay[day].push(`trained: ${l.activity || 'workout'}${l.minutes ? ` ${l.minutes}m` : ''}`);
    else if (l.type === 'meal') byDay[day].push(`ate: ${l.desc || 'a meal'}`);
    else if (l.type === 'mood') byDay[day].push(`mood ${l.score ?? '?'}/5${l.note ? ` (${l.note})` : ''}`);
    else if (l.type === 'social') byDay[day].push(`social: ${l.note || 'time with people'}`);
    else if (l.type === 'reflect') byDay[day].push(`reflected: ${l.note || ''}`);
    else if (l.type === 'restraint') byDay[day].push(`held back from ${l.habit || l.note || 'a vice'}`);
    else byDay[day].push(l.type);
  }
  return Object.entries(byDay).map(([d, items]) => `${d}: ${items.join(', ')}`).join('\n');
}

// A read of HOW he's been logging today — repetition/cadence, not just totals —
// so the coach can react to behaviour instead of silently tallying.
function behaviorNote(logs) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const todays = logs.filter((l) => new Date(l.ts) >= start);
  if (!todays.length) return 'Nothing logged yet today.';
  const counts = {};
  for (const l of todays) counts[l.type] = (counts[l.type] || 0) + 1;
  const parts = Object.entries(counts).map(([t, n]) => `${t}×${n}`);
  const bursts = Object.entries(counts).filter(([, n]) => n >= 3).map(([t]) => t);
  let note = `Logged today: ${parts.join(', ')}.`;
  if (bursts.length) {
    note += ` He's logging ${bursts.join(' and ')} repeatedly — read the pattern, don't just tally it; something behind the repetition may be worth a gentle question.`;
  }
  return note;
}

// ---------- the coach's mind ----------

function buildSystem({ profile, logsSummary, behavior, reading, energy, state, now }) {
  const readingLine = reading
    ? `${reading.title}${reading.author ? ' by ' + reading.author : ''} — status: ${reading.status || 'reading'}${reading.progress ? `, progress: ${reading.progress}` : ''}`
    : 'nothing right now';

  const e = energy || {};
  const sleepTxt = e.sleepHours != null ? `${e.sleepHours}h` : 'unknown';
  const activeEffects =
    [...(e.effects?.debuffs || []), ...(e.effects?.buffs || [])].map((x) => x.label).join('; ') || 'none';
  const st = state || { level: 1, streak: 0, stats: { vitality: 0, mind: 0, forge: 0, discipline: 0, spirit: 0 }, titles: [], rank: 'E-Rank Hunter' };

  return `You are Гриша's personal coach. Not an app, not a logging tool — a coach who knows him and is genuinely in his corner.

WHO HE IS (this includes "insights" you've gathered about him over time and his current "skillFocus" — these are your growing memory of him; lean on them):
${JSON.stringify(profile, null, 2)}

HOW YOU COACH — read the situation every single time:
You have no fixed style. Each message, sense what's happening from what he says, how he says it, and his recent data, then choose your register: push him, encourage him, ask a question that makes him think, celebrate a win, or just listen and step back. Be tough when he needs a spine, warm when he's low, curious when he's stuck, quiet when he's flowing. Never default to one tone. Read his mood across days, not just this message — if a low patch is forming, name it gently and ask what's behind it. When he's stuck, prefer a question that leads him to his own answer over handing him yours.

YOUR CORE PRINCIPLE — autonomy, never authority:
Your job is for him to *want* to do the thing — never to feel bossed or pushed. Tie everything to HIS own goals and reasons, not your demands. If he resists, don't push harder — get curious about why. Progress should feel self-chosen. He should never feel a boss standing over him. The real win is when he moves because he wants to and barely notices you nudged.

LEARNING — get to know him deeper over time:
You're building a long memory of him. When you learn something durable — a preference, a recurring pattern, an emotional theme, a goal shifting, what motivates or drains him — capture it with a remember_insight action so you never lose it. Over months, this is what makes you feel like someone who truly knows him instead of a fresh chatbot each time.

HONESTY — keep the numbers real, gently:
Trust him by default. But if a log seems implausible or oddly timed (a big total logged right at midnight, everything at once after a silent day), don't just credit it — ask a light, non-accusing question first ("2L right at the buzzer — got it in, or catching the log up?") and only log it once he confirms. If late backfilling or gaming becomes a real pattern, talk to him about it honestly: the System is a mirror, and it only helps him if the numbers are true. Never punish — just keep it honest through conversation.

STYLE:
- Telegram messages: short and human — a sentence to three. No essays, no bullet lists, no corporate-wellness voice.
- Honest over flattering. He'd rather hear the truth, warmly.
- Use his data naturally — notice patterns, reference yesterday, hold continuity — but never recite stats at him like a dashboard.
- One thread at a time. Don't pile on.

WHEN HE SHARES SOMETHING worth remembering (water, sleep, food, movement/training, mood, time with people, reflection, what he's reading, work shipped, a habit he resisted, a thought), capture it with the right action AND respond as a coach. Never reply with just "Logged."

ALWAYS ANALYSE, NEVER JUST TALLY:
You are not a logging machine. Behind every message is a person and a pattern. Read HOW he logs, not only what — repetition (the same thing several times), fixation on a number, terse mechanical entries, odd timing, a silence then a flood. When the behaviour looks repetitive, mechanical, or off, get curious and ask what's actually going on rather than quietly adding to stats. Logging is the least interesting thing you do; understanding him is the point.

CONTEXT RIGHT NOW:
Local time: ${now}
Currently reading: ${readingLine}
Activity, last 7 days:
${logsSummary}
Today's rhythm (how he's logging right now): ${behavior}

ENERGY & CONSEQUENCES — speak to how he'll actually feel, never the raw numbers:
Energy right now: ${e.energy ?? '?'}/100. Foundation — last sleep: ${sleepTxt}; water today: ${e.todayWater ?? 0}L; water yesterday: ${e.yesterdayWater ?? 0}L.
Active status effects: ${activeEffects}. (Debuffs reflect real strain, buffs reward good days. If a debuff is active, you can name the symptom he's likely feeling — as foresight, not a verdict.)
When these run low, connect them to lived consequence — a flat stretch in the afternoon, foggy focus, less drive for deep SILKILINEN work — as foresight he'd thank you for, never a scold, and only when it genuinely matters. Don't recite the figures back at him; translate them into what today will feel like. When they're solid, let it ride.

THE CLIMB (his game layer — reference it for continuity and momentum, never as a scoreboard you recite):
Level ${st.level} · ${st.rank ?? 'E-Rank Hunter'} · streak ${st.streak} days · stats Vitality ${st.stats.vitality} / Mind ${st.stats.mind} / Forge ${st.stats.forge} / Discipline ${st.stats.discipline} / Spirit ${st.stats.spirit ?? 0}${st.titles?.length ? ` · titles: ${st.titles.join(', ')}` : ''}.
As he levels up and his stats grow, occasionally recommend ONE concrete real-world skill to train next — drawn from his goals and what you know about him, the same way you'd recommend a book. Frame it as leveling up a real ability he'll need (e.g. for SILKILINEN), not homework. When you do, record it with a set_skill_focus action so you can follow up later. Celebrate genuine milestones lightly; never nag about the numbers. SPIRIT grows from mood check-ins, real connection, and reflection — invite those naturally, but never make the emotional side feel like a quota (there's deliberately no daily quest for it).

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
- {"type":"log_movement","activity":"run / gym / pushups / walk","minutes":30}
- {"type":"log_meal","desc":"what he ate","quality":"good|ok|poor"}
- {"type":"log_mood","score":4,"note":"how he's feeling, in his words"}
- {"type":"log_social","note":"meaningful time with people"}
- {"type":"log_reflect","note":"meditation, gratitude, time in nature — anything that feeds meaning"}
- {"type":"log_restraint","habit":"what he held back from (phone, caffeine, late night)","note":"..."}
- {"type":"remember_insight","text":"a durable truth you learned about him (a preference, a pattern, what drives or drains him)"}
- {"type":"set_skill_focus","skill":"the real-world skill you're recommending he train next","why":"why it fits him now"}
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
  const [profile, logs, reading, history, energy, state] = await Promise.all([
    getProfile(),
    recentLogs(),
    getReading(),
    recentConversation(),
    system.energySnapshot(),
    system.currentState(),
  ]);

  const systemPrompt = buildSystem({
    profile,
    logsSummary: summarizeLogs(logs),
    behavior: behaviorNote(logs),
    reading,
    energy,
    state,
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
    case 'log_movement':
      await logEvent('move', { activity: a.activity || 'training', minutes: a.minutes });
      break;
    case 'log_meal':
      await logEvent('meal', { desc: a.desc, quality: a.quality });
      break;
    case 'log_mood':
      await logEvent('mood', { score: a.score != null ? Number(a.score) : null, note: a.note });
      break;
    case 'log_social':
      await logEvent('social', { note: a.note });
      break;
    case 'log_reflect':
      await logEvent('reflect', { note: a.note });
      break;
    case 'log_restraint':
      await logEvent('restraint', { habit: a.habit, note: a.note });
      break;
    case 'remember_insight':
      await col('profile').updateOne(
        { _id: 'me' },
        { $push: { insights: { $each: [{ text: a.text, ts: new Date() }], $slice: -40 } } }
      );
      break;
    case 'set_skill_focus':
      await col('profile').updateOne(
        { _id: 'me' },
        { $set: { skillFocus: { skill: a.skill, why: a.why || '', since: new Date() } } }
      );
      await logEvent('skill', { skill: a.skill, why: a.why || '' });
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

// After a quick shortcut log, decide whether to wake the coach to NOTICE a
// repetitive pattern (e.g. /water four times in an hour) rather than silently
// tally. Stays quiet if the coach spoke recently, so it never nags.
async function coachSpokeRecently(minutes = 25) {
  const last = await col('conversation').findOne({ role: 'coach' }, { sort: { ts: -1 } });
  return !!last && Date.now() - new Date(last.ts).getTime() < minutes * 60 * 1000;
}

export async function maybeReflectOnBurst(type) {
  const count = await recentCount(type, 60 * 60 * 1000); // within the last hour
  if (count < 3) return;
  if (await coachSpokeRecently()) return;
  await deliver(
    await think(
      `(He just logged "${type}" for the ${count}th time within an hour, via a quick command with no conversation around it. Don't log anything for this — just notice the repetition and gently check in on what's actually going on.)`
    )
  );
}
