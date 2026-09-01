// Pocket's storage. Its own database (DB_NAME=pocket) on the same Atlas cluster, for the same
// reason the steward has one: the cluster is a 512 MB M0 shared with a live Stripe store, and
// three apps that cannot reach each other's data is the whole point of the split.
//
// Sanitised on the way IN as well as OUT, so a future caller that forgets cannot persist a
// field the whitelist has never heard of — and, more importantly here, cannot persist an
// amount with no currency attached to it.

// SINGLE-TENANT ON PURPOSE, so this file uses rawCol() and not col().
//
// col() returns a per-user view whose every method calls uid(), and uid() THROWS when there is
// no user context. That scoping exists because Kept is multi-tenant and one database holds
// many people; this app is one person's, in a database of its own, where a userId field would
// be a constant on every document and buy nothing. rawCol() is the honest choice here, and
// this comment is the justification CLAUDE.md asks for whenever it is used.
//
// Learned the hard way: built on col(), it connected, then died on the first createIndex — and
// had that call not existed it would have crashed later on the first save instead, which is a
// worse place to find out.
import { rawCol as col } from '../db.js';
import { cleanAccount, cleanFlow, cleanEvent } from './money.js';

export async function accounts() {
  return (await col('accounts').find({}).toArray()).map(cleanAccount);
}

export async function saveAccount(a) {
  const clean = cleanAccount(a);
  await col('accounts').updateOne({ id: clean.id }, { $set: clean }, { upsert: true });
  return clean;
}

export async function removeAccount(id) {
  const r = await col('accounts').deleteOne({ id: String(id || '') });
  return r.deletedCount > 0;
}

/** Flows within a window. Bounded by the caller — "this month" is a decision made where the
 *  timezone is known, not guessed at in the data layer. */
export async function flows({ from = 0, to = Date.now() } = {}) {
  const docs = await col('flows').find({ ts: { $gte: from, $lte: to } }).sort({ ts: -1 }).toArray();
  return docs.map(cleanFlow);
}

export async function addFlow(f) {
  const clean = cleanFlow(f);
  await col('flows').insertOne(clean);
  return clean;
}

export async function removeFlow(id) {
  const r = await col('flows').deleteOne({ id: String(id || '') });
  return r.deletedCount > 0;
}

/** Recurring flows, re-stamped into the current month. Salary and the Cairo rent do not need
 *  typing in twelve times a year, and a month that silently omits them reports a surplus he
 *  does not have. */
export async function recurring() {
  return (await col('flows').find({ recurring: true }).toArray()).map(cleanFlow);
}

export async function getGoal() {
  const doc = await col('settings').findOne({ _id: 'goal' });
  return doc ? { monthly: Number(doc.monthly) || 0, currency: doc.currency || 'EUR' } : null;
}

export async function setGoal({ monthly, currency }) {
  const goal = { monthly: Math.max(0, Number(monthly) || 0), currency: String(currency || 'EUR').toUpperCase() };
  await col('settings').updateOne({ _id: 'goal' }, { $set: goal }, { upsert: true });
  return goal;
}

export async function ensureIndexes() {
  await col('accounts').createIndex({ id: 1 }, { unique: true });
  await col('flows').createIndex({ ts: -1 });
  await col('flows').createIndex({ id: 1 }, { unique: true });
  await col('flows').createIndex({ recurring: 1 });
}

// ---- The plan's future events ----
// "In three years the rent goes up." "From year five there's a second flat." Stored so a
// ten-year view is built from what he actually expects rather than from a flat line.
export async function getPlanEvents() {
  const doc = await col('settings').findOne({ _id: 'plan' });
  return {
    years: Number(doc?.years) || 10,
    list: (Array.isArray(doc?.list) ? doc.list : []).map(cleanEvent),
  };
}

export async function addPlanEvent(e) {
  const clean = cleanEvent({ ...e, id: Date.now().toString(36) });
  await col('settings').updateOne({ _id: 'plan' }, { $push: { list: clean } }, { upsert: true });
  return clean;
}

export async function removePlanEvent(id) {
  await col('settings').updateOne({ _id: 'plan' }, { $pull: { list: { id: String(id) } } });
}

export async function setPlanYears(years) {
  const y = Math.max(1, Math.min(40, Math.round(Number(years) || 10)));
  await col('settings').updateOne({ _id: 'plan' }, { $set: { years: y } }, { upsert: true });
  return y;
}
