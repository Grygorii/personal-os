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
import { cleanAccount, cleanFlow, cleanEvent, cleanSub, cleanPayment, newId } from './money.js';

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
  const clean = cleanPayment({ ...payment, id: newId() });
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

// ---- What he exchanged at ----
//
// He did not earn Egyptian pounds; he took euro and converted them. So the whole position has one
// known cost, and asking him to type a starting rate into five separate holdings was asking five
// times for one fact. Kept per currency, and any holding with a rate of its own still wins.
export async function getFxBasis() {
  const doc = await col('settings').findOne({ _id: 'fx' });
  const out = {};
  for (const [cur, v] of Object.entries(doc || {})) {
    if (cur === '_id' || !v || typeof v !== 'object') continue;
    if (Number(v.rateThen) > 0) out[cur] = { rateThen: Number(v.rateThen), at: Number(v.at) || null };
  }
  return out;
}

export async function setFxBasis(currency, rateThen, at) {
  const cur = String(currency || '').toUpperCase().slice(0, 3);
  if (!/^[A-Z]{3}$/.test(cur)) return null;
  // A rate of nothing is not a rate; clearing it is done by sending nothing at all.
  if (!(Number(rateThen) > 0)) {
    await col('settings').updateOne({ _id: 'fx' }, { $unset: { [cur]: '' } }, { upsert: true });
    return null;
  }
  const val = { rateThen: Number(rateThen), at: Number(at) || Date.now() };
  await col('settings').updateOne({ _id: 'fx' }, { $set: { [cur]: val } }, { upsert: true });
  return val;
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

// ---- The exchange rate, day by day ----
//
// The app could always convert his money and never say what the currency itself had done to
// him, because it kept no history. It does now: one small document a day, written the first
// time the app is opened. Nothing is backfilled and nothing is invented — the record starts the
// day it starts, and the app says so rather than drawing a line through a single point.
export async function recordRates(table) {
  if (!table?.rates || !table.base) return;
  const day = new Date().toISOString().slice(0, 10);
  // $setOnInsert, so the first open of the day writes and every other open costs nothing. This
  // runs on a 512 MB cluster shared with a live shop; a write per page view is not acceptable.
  await col('meta').updateOne(
    { _id: `fx:${day}` },
    { $setOnInsert: { base: table.base, rates: table.rates, at: table.at || Date.now(), day } },
    { upsert: true },
  );
}

export async function rateHistory(days = 400) {
  const docs = await col('meta')
    .find({ _id: { $regex: '^fx:' } })
    .sort({ _id: -1 })
    .limit(days)
    .toArray();
  return docs.map((d) => ({ base: d.base, rates: d.rates, at: d.at })).sort((a, b) => a.at - b.at);
}

/** EVERYTHING, in one object.
 *
 *  His whole household — four certificates, four loans, a flat, the subscriptions, the plan — now
 *  lives in one collection on a free-tier cluster shared with a live shop, with delete buttons
 *  that have no undo and no way at all to get the data out. That is the largest remaining risk in
 *  this app and it is not a money bug; it is that a mistake or a bad day for Atlas takes the lot.
 *
 *  Sent to his own Telegram as a file, so the backup lives in a chat history he keeps for ever
 *  and not in the thing being backed up. */
export async function exportAll() {
  const [accounts, flows, subs, settings] = await Promise.all([
    col('accounts').find({}).toArray(),
    col('flows').find({}).sort({ ts: -1 }).toArray(),
    col('subs').find({}).toArray(),
    col('settings').find({}).toArray(),
  ]);
  const strip = (d) => { const { _id, ...rest } = d; return rest; };
  return {
    app: 'pocket',
    exportedAt: new Date().toISOString(),
    counts: { accounts: accounts.length, flows: flows.length, subs: subs.length },
    accounts: accounts.map(strip),
    flows: flows.map(strip),
    subs: subs.map(strip),
    settings: settings.map((d) => ({ id: d._id, ...strip(d) })),
  };
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
    // What he expects money with NO rate of its own to earn. Nought by default, because the app
    // has no opinion about what a market does and inventing one is how "5% a year" ended up on
    // his screen attached to certificates paying twenty.
    yieldPct: Number(doc?.yieldPct) || 0,
    list: (Array.isArray(doc?.list) ? doc.list : []).map(cleanEvent),
  };
}

export async function setPlanYield(yieldPct) {
  const y = Math.max(0, Math.min(30, Number(yieldPct) || 0));
  await col('settings').updateOne({ _id: 'plan' }, { $set: { yieldPct: y } }, { upsert: true });
  return y;
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

/** Replace the whole list at once — used by the template, and only ever with his say-so. */
export async function setPlanEvents(list) {
  const clean = (Array.isArray(list) ? list : []).slice(0, 200).map(cleanEvent);
  await col('settings').updateOne({ _id: 'plan' }, { $set: { list: clean } }, { upsert: true });
  return clean;
}

export async function addPlanEvent(e) {
  const clean = cleanEvent({ ...e, id: newId() });
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
