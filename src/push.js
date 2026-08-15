// One good notification a day: a thought you kept, handed back.
//
// Why this and not a streak, a badge or a nag. The number that decides whether Kept is worth
// anything is whether people come back — and the honest way to earn a return is to give
// something on the way in, not to ask for something. A line you wrote yourself, months ago,
// out of a book you chose, is the only push notification this product has any right to send.
//
// One a day. Never two. If there is nothing kept yet, nothing is sent — an empty product has
// nothing to say and should say nothing.

import webpush from 'web-push';
import crypto from 'crypto';
import { rawCol, col } from './db.js';
import { config } from './config.js';
import { runAs } from './ctx.js';

let ready = false;

/**
 * VAPID is a keypair that proves to a push service the messages really came from this server.
 * Environment first, because that is where a private key belongs. But a key that only exists
 * once somebody remembers to set two Railway variables is a feature that never turns on, so
 * one is generated and kept in the database if none is configured — and logged loudly, so it
 * can be moved into the environment properly.
 */
export async function initPush() {
  let pub = config.vapidPublic;
  let priv = config.vapidPrivate;
  if (!pub || !priv) {
    const saved = await rawCol('meta').findOne({ _id: 'vapid' });
    if (saved?.publicKey && saved?.privateKey) {
      pub = saved.publicKey;
      priv = saved.privateKey;
    } else {
      const keys = webpush.generateVAPIDKeys();
      await rawCol('meta').updateOne(
        { _id: 'vapid' },
        { $set: { publicKey: keys.publicKey, privateKey: keys.privateKey, madeAt: new Date() } },
        { upsert: true }
      );
      pub = keys.publicKey;
      priv = keys.privateKey;
      console.log('[push] generated a VAPID keypair and stored it. To hold it in the');
      console.log('[push] environment instead, set VAPID_PUBLIC / VAPID_PRIVATE in Railway:');
      console.log(`[push] VAPID_PUBLIC=${keys.publicKey}`);
    }
  }
  // mailto is required by the spec so a push service has somebody to contact about abuse.
  webpush.setVapidDetails(`mailto:${config.ownerEmail || 'hello@readkept.com'}`, pub, priv);
  ready = true;
  return pub;
}

export async function publicKey() {
  if (config.vapidPublic) return config.vapidPublic;
  const saved = await rawCol('meta').findOne({ _id: 'vapid' });
  return saved?.publicKey || null;
}

/** One row per DEVICE — a person's phone and their laptop are two subscriptions, not one. */
export async function subscribe(userId, sub) {
  const endpoint = String(sub?.endpoint || '');
  if (!endpoint.startsWith('https://') || !sub?.keys?.p256dh || !sub?.keys?.auth) return false;
  await rawCol('push_subs').updateOne(
    { _id: crypto.createHash('sha256').update(endpoint).digest('hex') },
    { $set: { userId, endpoint, keys: sub.keys, updated: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
  return true;
}

export async function unsubscribeAll(userId) {
  await rawCol('push_subs').deleteMany({ userId });
}

/**
 * Send to every device a person has. A subscription that the push service says is dead gets
 * deleted rather than retried forever — 404 and 410 mean the browser is gone for good.
 */
async function sendTo(userId, payload) {
  if (!ready) return 0;
  const subs = await rawCol('push_subs').find({ userId }).toArray();
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload));
      sent++;
    } catch (err) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await rawCol('push_subs').deleteOne({ _id: s._id });
      } else {
        console.warn('[push] send failed:', err?.statusCode || err?.message);
      }
    }
  }
  return sent;
}

/** A thought they kept, chosen at random, with the book it came from. */
async function pickThought(userId) {
  const shelf = await rawCol('books').findOne({ userId });
  const all = [];
  for (const b of shelf?.books || []) {
    for (const n of b.notes || []) {
      const text = String(n.text || '').trim();
      if (text) all.push({ text, page: n.page, title: b.title });
    }
  }
  if (!all.length) return null;
  return all[Math.floor(Math.random() * all.length)];
}

const trim = (s, n) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s);

/**
 * Every kind of notification this app can send, in one list. The switches on the settings
 * page are built from this, the scheduler reads the same names, and a kind that is not here
 * cannot be sent — so a switch can never exist for something that never arrives, and a
 * notification can never arrive with no switch to stop it.
 */
export const KINDS = [
  { id: 'daily', label: 'A thought a day',
    note: 'One line you kept, handed back each morning.', when: '0 9 * * *' },
  { id: 'quiz', label: 'Which book was this?',
    note: 'One of your own thoughts, and you name the book it came from.', when: '0 19 * * 2,4,6' },
  { id: 'idle', label: 'A book gone quiet',
    note: "When a book you started hasn't had a thought in a fortnight.", when: '0 11 * * 0' },
];

/** Default ON. Off only when they have actually said so. */
export const wants = (user, kind) => user?.notify?.[kind] !== false;

/**
 * The daily round. Runs per person in their own timezone via the agent runner, so nobody is
 * woken at four in the morning by somebody else's schedule.
 */
export async function dailyThought(user) {
  if (!user?._id) return;
  // Default ON, and off the moment they say so. The check is here rather than at send time
  // so a person who turned it off costs nothing to skip.
  if (!wants(user, 'daily')) return;
  const t = await runAs(user, () => pickThought(user._id));
  if (!t) return;                       // nothing kept yet: say nothing
  await sendTo(user._id, {
    title: t.title ? `From ${trim(t.title, 40)}` : 'Something you kept',
    body: trim(t.text, 160),
    url: '/app',
    tag: 'daily-thought',              // a new one REPLACES yesterday's, never stacks
  });
}

/** Fired by the toggle, so somebody can see it work the moment they turn it on. */
export async function sendTest(user) {
  const t = await runAs(user, () => pickThought(user._id));
  return sendTo(user._id, t
    ? { title: t.title ? `From ${trim(t.title, 40)}` : 'Something you kept', body: trim(t.text, 160), url: '/app', tag: 'daily-thought' }
    : { title: 'Kept', body: 'This is what a daily thought will look like. Keep one and it will be yours.', url: '/app', tag: 'daily-thought' });
}

/** Their own words, and the book withheld. A game rather than a nag. */
export async function quizNudge(user) {
  if (!user?._id || !wants(user, 'quiz')) return;
  const t = await runAs(user, () => pickThought(user._id));
  if (!t) return;
  await sendTo(user._id, {
    title: 'Which book was this?',
    body: trim(t.text, 150),
    url: '/app',
    tag: 'quiz-nudge',
  });
}

/**
 * A book that was started and then went quiet. Said as a fact and not a scolding — nobody
 * needs an app to tell them off, and the last thought is the part worth being reminded of.
 */
export async function idleNudge(user) {
  if (!user?._id || !wants(user, 'idle')) return;
  const shelf = await rawCol('books').findOne({ userId: user._id });
  const cutoff = Date.now() - 14 * 864e5;
  let quietest = null;
  for (const b of shelf?.books || []) {
    if (b.status !== 'reading') continue;
    const notes = (b.notes || []).filter((n) => n.ts);
    if (!notes.length) continue;
    const last = Math.max(...notes.map((n) => new Date(n.ts).getTime()));
    if (last > cutoff) continue;                    // still warm
    if (!quietest || last < quietest.last) quietest = { book: b, last, note: notes.find((n) => new Date(n.ts).getTime() === last) };
  }
  if (!quietest) return;
  const days = Math.round((Date.now() - quietest.last) / 864e5);
  await sendTo(user._id, {
    title: `${trim(quietest.book.title || 'A book', 40)} — quiet for ${days} days`,
    body: quietest.note?.text ? `Last thing you kept: ${trim(quietest.note.text, 120)}` : 'Still on your shelf, waiting.',
    url: '/app',
    tag: 'idle-nudge',
  });
}
