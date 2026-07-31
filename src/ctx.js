import { AsyncLocalStorage } from 'async_hooks';

// Who is this request for? Set once at each entry point (an inbound Telegram message, a
// cron tick, an authenticated Mini App call) and read implicitly by the data layer, so no
// query has to remember to pass a userId — and none can forget.
//
// The critical property: outside a user context uid() THROWS. A missed code path fails
// loudly in the logs instead of silently reading or writing someone else's data.

const als = new AsyncLocalStorage();

export function runAs(user, fn) {
  if (!user?._id) throw new Error('runAs requires a user with an _id');
  return als.run({ user }, fn);
}

export function currentUser() {
  return als.getStore()?.user || null;
}

export function uid() {
  const u = currentUser();
  if (!u) throw new Error('No user context — refusing to touch user data (this is a bug: wrap the entry point in runAs)');
  return u._id;
}

// For the few places that legitimately have no user (boot, global config).
export function hasUser() {
  return !!als.getStore()?.user;
}

// What to call the person we're serving. Every prompt must use this — hardcoding a name
// meant a stranger's bot addressed them as someone else entirely.
export function personName() {
  const u = currentUser();
  return u?.displayName || u?.name || 'them';
}

// The language rule handed to every prompt. Without it the model drifts between languages
// mid-conversation, which is disorienting.
export function languageRule() {
  const lang = currentUser()?.language;
  return lang && lang !== 'auto'
    ? `LANGUAGE: Always write in ${lang}. Never switch, even if a quoted title or their message is in another language — unless they explicitly ask you to change.`
    : 'LANGUAGE: Reply in the same language they wrote to you in, and stay consistent within the conversation.';
}
