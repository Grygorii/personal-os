import { ask } from '../llm.js';
import { getProfile, logEvent, col } from '../db.js';
import { send, sendPings } from '../telegram.js';
import * as system from '../system.js';

// --- current-book state (one document) ---
async function getReading() {
  return col('reading').findOne({ _id: 'current' });
}
async function setReading(data) {
  await col('reading').updateOne(
    { _id: 'current' },
    { $set: { ...data, updatedAt: new Date() } },
    { upsert: true }
  );
}
async function recentTitles() {
  const rows = await col('logs')
    .find({ type: 'book' })
    .sort({ ts: -1 })
    .limit(10)
    .toArray();
  return rows.map((r) => r.title).filter(Boolean);
}

async function suggestBook() {
  const profile = await getProfile();
  const history = await recentTitles();
  const text = await ask({
    system:
      "You are Гриша's reading coach and you know him well. Recommend ONE next " +
      'book with a short, specific reason tied to his interests and goals. ' +
      'End by telling him he can reply "/read <title>" to start it — or pick his own.',
    user:
      `What I know about him: ${JSON.stringify(profile)}.\n` +
      `Recently read/logged: ${history.join(', ') || 'nothing yet'}.`,
    maxTokens: 300,
  });
  await send(`📚 *Book suggestion*\n\n${text}`);
}

// Scheduled trigger (e.g. Sunday evening).
export async function run() {
  const reading = await getReading();

  // No active book → suggest one based on what we know about him.
  if (!reading || reading.status === 'finished') {
    await suggestBook();
    return;
  }

  // Active book → ask one essay question about it.
  const profile = await getProfile();
  const question = await ask({
    system:
      "You are Гриша's reading coach. He is currently reading a book. Ask ONE " +
      'thoughtful essay question (he should answer in ~200 words) about a theme ' +
      'or idea in it, calibrated to where he is. Reply with just the question.',
    user:
      `Book: ${reading.title}${reading.author ? ' by ' + reading.author : ''}. ` +
      `Progress: ${reading.progress || 'unknown'}. About him: ${JSON.stringify(profile)}.`,
    maxTokens: 200,
  });
  await setReading({ ...reading, status: 'awaiting_essay', lastQuestion: question });
  await send(`📖 *${reading.title}* — essay time:\n\n${question}\n\n_Reply with ~200 words and I'll give feedback._`);
}

// Command + free-text handler.
export async function command(text) {
  // /read <title>  → start a book he chose himself
  let m = text.match(/^\/read(?:ing)?\s+(.+)/i);
  if (m) {
    const title = m[1].trim();
    await setReading({ title, author: '', status: 'reading', progress: 'just started', source: 'self' });
    await logEvent('book', { title, event: 'started', source: 'self' });
    const pings = await system.recordAction({ type: 'set_reading', title });
    await send(`Got it — you're reading *${title}*. I'll start asking you about it. 📖`);
    await sendPings(pings);
    return true;
  }

  // /suggest  → suggest on demand
  if (/^\/suggest\b/i.test(text)) {
    await suggestBook();
    return true;
  }

  // /progress <note>
  m = text.match(/^\/progress\s+(.+)/i);
  if (m) {
    const reading = await getReading();
    if (!reading) {
      await send('No active book yet. Start one with `/read <title>`.');
      return true;
    }
    await setReading({ ...reading, progress: m[1].trim() });
    const pings = await system.recordAction({ type: 'log_progress', note: m[1].trim() });
    await send('Noted where you are. 👍');
    await sendPings(pings);
    return true;
  }

  // /finished
  if (/^\/finished\b/i.test(text)) {
    const reading = await getReading();
    if (reading) {
      await logEvent('book', { title: reading.title, event: 'finished' });
      await setReading({ ...reading, status: 'finished' });
      const pings = await system.recordAction({ type: 'finish_book' });
      await send(`🎉 Logged *${reading.title}* as finished. I'll suggest your next read.`);
      await sendPings(pings);
    } else {
      await send('No active book to finish.');
    }
    return true;
  }

  // Free text while awaiting an essay → treat it as the essay and give feedback.
  const reading = await getReading();
  if (reading?.status === 'awaiting_essay' && !text.startsWith('/')) {
    const feedback = await ask({
      system:
        "You are Гриша's reading coach. He wrote an essay answering your question. " +
        'Give warm, specific, honest feedback: one thing that landed, one thing to ' +
        'push further, and one follow-up thought. Be concise and direct.',
      user: `Question: ${reading.lastQuestion}\n\nHis essay:\n${text}`,
      maxTokens: 500,
    });
    await logEvent('essay', {
      book: reading.title,
      question: reading.lastQuestion,
      essay: text,
      feedback,
    });
    await setReading({ ...reading, status: 'reading' });
    const pings = await system.recordAction({ type: 'log_essay', book: reading.title });
    await send(`✍️ *Feedback*\n\n${feedback}`);
    await sendPings(pings);
    return true;
  }

  return false; // not handled by this agent
}
