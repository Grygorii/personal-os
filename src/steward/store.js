// ---- Where the book lives ----
//
// Its own database (DB_NAME=steward on the same Atlas cluster), which is the isolation that
// matters here: the cluster is a 512 MB M0 SHARED WITH THE LIVE STRIPE STORE, and Kept sits
// on it too. A separate database means a bad query in a bot that is being rewritten cannot
// reach either of them.
//
// Nothing time-series is stored. Prices are fetched, used and dropped — a row per symbol per
// day is how a free tier fills up, and it buys nothing a journal needs.

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
import { cleanPosition } from './book.js';

const POSITIONS = 'positions';

export async function allPositions() {
  const docs = await col(POSITIONS).find({}).toArray();
  return docs.map(cleanPosition);
}

export async function getPosition(idOrTicker) {
  const key = String(idOrTicker || '').trim();
  const doc = await col(POSITIONS).findOne({ $or: [{ id: key }, { ticker: key.toUpperCase() }] });
  return doc ? cleanPosition(doc) : null;
}

export async function savePosition(p) {
  const clean = cleanPosition(p);
  // Sanitised on the way IN as well as on the way out. A field that never passes the
  // whitelist cannot be persisted by a future caller that forgot to call it.
  await col(POSITIONS).updateOne({ id: clean.id }, { $set: clean }, { upsert: true });
  return clean;
}

/** Record a buy or a sell against a ticker, opening the position if it is new. Returns the
 *  position as it now stands, so the caller can tell him what he actually owns rather than
 *  what he asked for. */
export async function recordTrade({ ticker, action, qty, price, note, thesis, invalidation }) {
  const sym = String(ticker || '').toUpperCase();
  const existing = await getPosition(sym);
  const p = existing || cleanPosition({ ticker: sym, opened: Date.now() });
  const leg = { qty, price, ts: Date.now(), note };
  if (action === 'sell') p.exits = [...p.exits, leg];
  else p.entries = [...p.entries, leg];
  // A thesis given later fills a blank; it never silently overwrites what he wrote at entry.
  // The first version is the one worth keeping — it is the one that was written before he
  // knew how it turned out.
  if (thesis && !p.thesis) p.thesis = thesis;
  if (invalidation && !p.invalidation) p.invalidation = invalidation;
  return savePosition(p);
}

/** His answer to "does the thesis still hold?" — the entry the whole system is built to
 *  collect. */
export async function recordCheck({ ticker, verdict, note }) {
  const p = await getPosition(ticker);
  if (!p) return null;
  p.checks = [...p.checks, { ts: Date.now(), verdict, note }];
  return savePosition(p);
}

/** What share of the book this position is meant to be. Without it "drifted" has no meaning. */
export async function setTarget({ ticker, target }) {
  const p = await getPosition(ticker);
  if (!p) return null;
  p.target = target;
  return savePosition(p);
}

export async function setThesis({ ticker, thesis, invalidation }) {
  const p = await getPosition(ticker);
  if (!p) return null;
  if (thesis != null) p.thesis = thesis;
  if (invalidation != null) p.invalidation = invalidation;
  return savePosition(p);
}

// ---- The funding plan ----
// One document, not a collection: there is one plan. It is what turns "this is a $1,000 book"
// into "this is a $25,000 book being funded over two years", which is the difference between
// the concentration rules being useful and being noise for a year.
export async function getPlan() {
  const doc = await col('settings').findOne({ _id: 'plan' });
  if (!doc) return null;
  return {
    monthly: Number(doc.monthly) || 0,
    months: Number(doc.months) || 0,
    startCapital: Number(doc.startCapital) || 0,
    startedAt: Number(doc.startedAt) || Date.now(),
  };
}

export async function setPlan({ monthly, months, startCapital }) {
  const plan = {
    monthly: Math.max(0, Number(monthly) || 0),
    months: Math.max(0, Math.min(600, Number(months) || 0)),
    startCapital: Math.max(0, Number(startCapital) || 0),
    startedAt: Date.now(),
  };
  await col('settings').updateOne({ _id: 'plan' }, { $set: plan }, { upsert: true });
  return plan;
}

// Filings read, kept so the NEXT one can be compared against it. One quarter's cover means
// little; cover falling from 1.8x to 1.05x over three quarters is the whole story.
export async function saveDigest({ ticker, url, figures, coverage }) {
  await col('digests').insertOne({ ticker, url, figures, coverage, at: Date.now() });
}

export async function lastDigest(ticker) {
  const rows = await col('digests').find({ ticker }).sort({ at: -1 }).limit(1).toArray();
  return rows[0] || null;
}

export async function ensureIndexes() {
  await col(POSITIONS).createIndex({ id: 1 }, { unique: true });
  await col(POSITIONS).createIndex({ ticker: 1 });
  await col('digests').createIndex({ ticker: 1, at: -1 });
}
