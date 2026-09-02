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
import { cleanAccount, cleanFlow, cleanEvent, cleanSub, cleanPayment } from './money.js';

export async function accounts() {
  return (await col('accounts').find({}).toArray()).map(cleanAccount);
}

export async function saveAccount(a) {
  const clean = cleanAccount(a);
  await col('accounts').updateOne({ id: clean.id }, { $set: clean }, { upsert: true });
  return clean;
}

/** An extra payment against a loan — an overpayment, a lump off the principal, an instalment the
 *  start date does not account for. Appended to the account's own history, because a balance
 *  derived only from dates says he owes what a borrower who never paid a penny extra would owe. */
export async function addPayment(id, payment) {
  const doc = await col('accounts').findOne({ id: String(id || '') });
  if (!doc) return null;
  const clean = cleanPayment({ ...payment, id: Date.now().toString(36) });
  if (!(clean.amount > 0)) return null;
  const merged = cleanAccount({ ...doc, payments: [...(doc.payments || []), clean] });
  await col('accounts').updateOne({ id: doc.id }, { $set: merged });
  return merged;
}

export async function removePayment(id, paymentId) {
  const doc = await col('accounts').findOne({ id: String(id || '') });
  if (!doc) return null;
  const merged = cleanAccount({ ...doc, payments: (doc.payments || []).filter((p) => p.id !== String(paymentId)) });
  await col('accounts').updateOne({ id: doc.id }, { $set: merged });
  return merged;
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

/** Change part of something already recorded.
 *
 *  Read, merge, sanitise, write the whole clean document. Deliberately NOT a bare $set of the
 *  patch: the cleaners are whitelists, and a whitelist applied to a fragment would drop every
 *  field the fragment did not mention. Merging first means an absent key keeps what is stored,
 *  which is the rule CLAUDE.md arrived at the hard way when `saveBooks` deleted a quiz.
 *
 *  The id is taken from the stored document, never from the patch, so an edit can never become
 *  an overwrite of a different row.
 */
export async function updateFlow(id, patch) {
  const doc = await col('flows').findOne({ id: String(id || '') });
  if (!doc) return null;
  const clean = cleanFlow({ ...doc, ...patch, id: doc.id });
  await col('flows').updateOne({ id: doc.id }, { $set: clean });
  return clean;
}

export async function updateAccount(id, patch) {
  const doc = await col('accounts').findOne({ id: String(id || '') });
  if (!doc) return null;
  const clean = cleanAccount({ ...doc, ...patch, id: doc.id });
  await col('accounts').updateOne({ id: doc.id }, { $set: clean });
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

// ---- Subscriptions ----
// Their own collection, not a flavour of flow: a flow is a thing that happened, a subscription
// is a thing that keeps happening. It exists before its first charge and outlives its last.
export async function subs() {
  return (await col('subs').find({}).toArray()).map(cleanSub);
}

export async function saveSub(s) {
  const clean = cleanSub(s);
  await col('subs').updateOne({ id: clean.id }, { $set: clean }, { upsert: true });
  return clean;
}

export async function updateSub(id, patch) {
  const doc = await col('subs').findOne({ id: String(id || '') });
  if (!doc) return null;
  const clean = cleanSub({ ...doc, ...patch, id: doc.id });
  await col('subs').updateOne({ id: doc.id }, { $set: clean });
  return clean;
}

export async function removeSub(id) {
  const r = await col('subs').deleteOne({ id: String(id || '') });
  return r.deletedCount > 0;
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
  await col('flows').createIndex({ subId: 1 });
  await col('subs').createIndex({ id: 1 }, { unique: true });
}

// ---- The plan's future events ----
// "In three years the rent goes up." "From year five there's a second flat." Stored so a
// ten-year view is built from what he actually expects rather than from a flat line.
export async function getPlanEvents() {
  const doc = await col('settings').findOne({ _id: 'plan' });
  return {
    years: Number(doc?.years) || 10,
    // Whether the plan starts from what he ACTUALLY saved this month, or only from the pieces
    // he has listed. Both are honest; which he means is a decision, not a default to guess at.
    // Measured, until he says otherwise — a plan built on a number he checked beats one built
    // on a number he hoped for.
    useMeasured: doc?.useMeasured !== false,
    list: (Array.isArray(doc?.list) ? doc.list : []).map(cleanEvent),
  };
}

export async function setPlanBase(useMeasured) {
  await col('settings').updateOne({ _id: 'plan' }, { $set: { useMeasured: !!useMeasured } }, { upsert: true });
  return !!useMeasured;
}

export async function updatePlanEvent(id, patch) {
  const doc = await col('settings').findOne({ _id: 'plan' });
  const list = (Array.isArray(doc?.list) ? doc.list : []);
  const i = list.findIndex((e) => e.id === String(id || ''));
  if (i < 0) return null;
  // Merge then sanitise, the same way an account or a flow is edited: cleaning the fragment
  // alone would drop every field the fragment did not mention.
  const clean = cleanEvent({ ...list[i], ...patch, id: list[i].id });
  list[i] = clean;
  await col('settings').updateOne({ _id: 'plan' }, { $set: { list } });
  return clean;
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
