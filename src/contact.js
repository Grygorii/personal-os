// A way for a reader to say something back.
//
// Why this exists: a hundred people reached the front page, twenty-six reached the sign-in
// screen, and none of them signed up. Not one could tell us why, because there was nowhere
// to say it. Every bug found so far has been found by the person who wrote the app, which is
// the worst possible sample of one.
//
// The consequence for the design is the whole design: THE PEOPLE WORTH HEARING FROM ARE
// USUALLY NOT SIGNED IN. "I can't get past the Google button" is, by definition, sent by
// somebody without an account. A contact form that requires an account is deaf in exactly
// the place we are blind, so a guest can write, and gets an id of their own so they can come
// back and read the reply.
//
// That id is a cookie, and it is only ever set when somebody actually sends a message — not
// for browsing. The privacy page can therefore still say, truthfully, that simply reading is
// not tracked.

import crypto from 'crypto';
import { rawCol } from './db.js';
import { config } from './config.js';
import { send } from './telegram.js';

const MSG_MAX = 2000;
const PER_DAY = 6;         // a person with a real problem needs a few tries, not sixty
const KEEP_MSGS = 200;     // a thread is a conversation, not a log file

export const newAnonId = () => `a:${crypto.randomBytes(16).toString('hex')}`;

/** A signed-in reader always gets the same thread; a guest gets the one their cookie names. */
export function threadIdFor(acct, anonId) {
  if (acct?._id) return `u:${acct._id}`;
  return /^a:[0-9a-f]{32}$/.test(String(anonId || '')) ? anonId : null;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Store a message from a reader and tell the owner it arrived.
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function fromReader({ threadId, acct, text, page }) {
  const body = String(text || '').replace(/\r\n?/g, '\n').trim().slice(0, MSG_MAX);
  if (body.length < 2) return { ok: false, error: 'empty' };
  if (!threadId) return { ok: false, error: 'no_thread' };

  const existing = await rawCol('contacts').findOne({ _id: threadId });
  // Counted per day rather than per session, so closing the app doesn't reset the allowance.
  const sentToday = existing?.dayCount?.on === today() ? existing.dayCount.n : 0;
  if (sentToday >= PER_DAY) return { ok: false, error: 'too_many' };

  const msg = { from: 'them', text: body, ts: new Date() };
  await rawCol('contacts').updateOne(
    { _id: threadId },
    {
      $push: { msgs: { $each: [msg], $slice: -KEEP_MSGS } },
      $inc: { unreadOwner: 1 },
      $set: {
        updated: new Date(),
        dayCount: { on: today(), n: sentToday + 1 },
        userId: acct?._id || null,
        // Best-effort identity so the inbox shows a person, not a hex string. A guest is a
        // guest — we have nothing to show but the fact that they weren't signed in.
        name: acct?.displayName || acct?.name || null,
        email: acct?.google?.email || null,
        // Which screen they were on when they wrote. The single most useful field in a bug
        // report, and the one nobody ever remembers to include.
        from: String(page || '').slice(0, 40) || null,
      },
      $setOnInsert: { createdAt: new Date(), unreadThem: 0 },
    },
    { upsert: true }
  );

  notifyOwner({ acct, body, threadId }).catch((e) => console.warn('[contact] ping failed:', e.message));
  return { ok: true };
}

// Telegram renders Markdown, so a message containing [text](http://…) would arrive in the
// owner's chat as a real, tappable link that a stranger chose. A preview is worth having;
// handing an untrusted author a link into the owner's phone is not. Strip the syntax, cap
// the length, and keep the message itself where it belongs — behind his own login.
function preview(s) {
  return String(s).replace(/[[\]()*_`~>#|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function notifyOwner({ acct, body, threadId }) {
  if (!config.telegramChatId) return;
  const who = acct ? preview(acct.displayName || acct.name || acct.google?.email || 'a reader') : 'someone not signed in';
  const more = body.length > 160 ? '…' : '';
  await send(
    `✉️ New message from ${who}\n\n${preview(body)}${more}\n\nReply: ${config.appUrl}/admin#messages`,
    config.telegramChatId
  );
}

/** The thread as its owner sees it. Reading it marks the owner's replies as seen. */
export async function myThread(threadId) {
  if (!threadId) return { msgs: [] };
  const t = await rawCol('contacts').findOne({ _id: threadId });
  if (!t) return { msgs: [] };
  if (t.unreadThem) await rawCol('contacts').updateOne({ _id: threadId }, { $set: { unreadThem: 0 } });
  return {
    msgs: (t.msgs || []).map((m) => ({ from: m.from, text: m.text, ts: m.ts })),
    sentToday: t.dayCount?.on === today() ? t.dayCount.n : 0,
    perDay: PER_DAY,
  };
}

/** How many replies are waiting, for the dot on the menu button. */
export async function unreadFor(threadId) {
  if (!threadId) return 0;
  const t = await rawCol('contacts').findOne({ _id: threadId }, { projection: { unreadThem: 1 } });
  return t?.unreadThem || 0;
}

/** Owner's side: every thread, most recently active first. */
export async function allThreads(limit = 50) {
  return rawCol('contacts').find().sort({ updated: -1 }).limit(limit).toArray();
}

export async function countWaiting() {
  return rawCol('contacts').countDocuments({ unreadOwner: { $gt: 0 } });
}

/** Owner's reply. Marked unread for them, and their unread count for us is cleared. */
export async function fromOwner(threadId, text) {
  const body = String(text || '').trim().slice(0, MSG_MAX);
  if (!threadId || body.length < 1) return { ok: false };
  const res = await rawCol('contacts').updateOne(
    { _id: threadId },
    {
      $push: { msgs: { $each: [{ from: 'me', text: body, ts: new Date() }], $slice: -KEEP_MSGS } },
      $set: { unreadOwner: 0, updated: new Date() },
      $inc: { unreadThem: 1 },
    }
  );
  return { ok: res.matchedCount > 0 };
}

/** Read without replying — so an inbox can be cleared of things that need no answer. */
export async function markRead(threadId) {
  await rawCol('contacts').updateOne({ _id: threadId }, { $set: { unreadOwner: 0 } });
}
