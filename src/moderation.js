import { col } from './db.js';
import { ask } from './llm.js';
import { send } from './telegram.js';
import { config } from './config.js';

// A moderator that ACTS. Waiting for a human to review a report is useless at 3am, so
// cheap deterministic checks run on every message and take action immediately; the model
// is only asked to explain an account AFTER it has already been stopped. That ordering
// keeps moderation fast, free, and awake.

// Attempts to turn the bot into a general-purpose free AI, or to break out of its role.
const JAILBREAK = [
  /ignore (all |your |previous |prior )*(instructions|prompts?|rules)/i,
  /system prompt|reveal your (prompt|instructions)|you are now|act as (a|an) (?!reader)/i,
  /\bDAN\b|developer mode|pretend you are|roleplay as/i,
  /disregard (the|your|all) (above|rules|instructions)/i,
];

// Using a reading mentor as a free coding/homework assistant.
const OFF_PRODUCT = [
  /write (me )?(a |an )?(python|javascript|java|c\+\+|sql|html|css|php|rust|go)\b/i,
  /(write|generate|draft) (me )?(a |an )?(essay|cover letter|resume|cv|article|blog post|email) (about|for|on)/i,
  /translate (this|the following)/i,
  /solve (this|the following) (equation|problem|homework)/i,
  /\bfix (my|this) code\b|\bdebug (my|this)\b/i,
];

const LIMITS = { maxChars: 6000, repeatWindow: 5, repeatThreshold: 3, strikesToSuspend: 3 };

// Cheap, local screening — no model call, no cost, runs on every message.
export function screen(text, recent = []) {
  const t = String(text || '');
  if (t.length > LIMITS.maxChars) return { flag: 'oversize', detail: `${t.length} chars` };
  for (const re of JAILBREAK) if (re.test(t)) return { flag: 'jailbreak', detail: t.slice(0, 120) };
  for (const re of OFF_PRODUCT) if (re.test(t)) return { flag: 'off_product', detail: t.slice(0, 120) };
  const same = recent.filter((r) => r && r.trim() && r.trim() === t.trim()).length;
  if (same >= LIMITS.repeatThreshold) return { flag: 'repetition', detail: `same message ${same + 1}×` };
  return null;
}

const MESSAGES = {
  jailbreak: "I only do books here — I'm not a general-purpose assistant. Let's talk about what you're reading.",
  off_product: "That's outside what I do. I'm a reading mentor — tell me about the book instead.",
  repetition: "You've sent that a few times — I've got it. Say something new and I'll pick it up.",
  oversize: "That's too long for me to work with. Send me the part that matters.",
};

// Record a strike and act on it: warn, then suspend. Returns true when the user should be
// stopped from proceeding with this message.
export async function flagAndAct(user, finding) {
  const strikes = (user.strikes || 0) + 1;
  await col('users').updateOne(
    { _id: user._id },
    {
      $set: { strikes, lastStrike: { ...finding, ts: new Date() } },
      $push: { strikeLog: { $each: [{ ...finding, ts: new Date() }], $slice: -20 } },
    }
  );
  console.warn(`[moderation] ${user._id} strike ${strikes} (${finding.flag}): ${finding.detail}`);

  if (strikes >= LIMITS.strikesToSuspend && user.role !== 'owner') {
    await col('users').updateOne({ _id: user._id }, { $set: { status: 'blocked', blockedAt: new Date(), blockedBy: 'moderator' } });
    await send(
      "I've had to stop this account — repeated attempts to use me for something I'm not. " +
        'If that was a misunderstanding, reply and it can be reviewed.',
      user.chatId
    );
    await explainToOwner(user, strikes, finding);
    return true;
  }

  await send(`${MESSAGES[finding.flag] || 'That one I have to skip.'}\n\n_(${strikes}/${LIMITS.strikesToSuspend})_`, user.chatId);
  return true;
}

// Only now — after the account is already stopped — spend a model call to tell the owner
// what happened in plain language, with a recommendation he can act on with one tap.
async function explainToOwner(user, strikes, finding) {
  let summary = `${strikes} strikes · latest: ${finding.flag}`;
  try {
    const log = await col('users').findOne({ _id: user._id }, { projection: { strikeLog: 1 } });
    summary = await ask({
      system:
        'You are the abuse moderator for a reading app. In 2-3 short sentences, tell the owner plainly what this user was doing, whether it looks deliberate or innocent, and whether you would keep them blocked or let them back in. Be direct and concrete.',
      user: `User ${user._id} (${user.name || 'unknown'}) auto-suspended after ${strikes} strikes.\nStrike log: ${JSON.stringify(log?.strikeLog || [])}`,
      maxTokens: 220,
    });
  } catch (e) {
    console.error('[moderation] summary failed:', e.message);
  }
  await send(
    `🛡 *Auto-suspended* ${user.name || user._id} (\`${user._id}\`)\n\n${summary}\n\n` +
      `Approve them back with \`/approve ${user._id}\` if this was wrong.`,
    config.telegramChatId
  );
}
