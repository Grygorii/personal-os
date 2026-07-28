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
