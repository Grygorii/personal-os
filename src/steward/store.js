// ---- Where the book lives ----
//
// Its own database (DB_NAME=steward on the same Atlas cluster), which is the isolation that
// matters here: the cluster is a 512 MB M0 SHARED WITH THE LIVE STRIPE STORE, and Kept sits
// on it too. A separate database means a bad query in a bot that is being rewritten cannot
// reach either of them.
//
// Nothing time-series is stored. Prices are fetched, used and dropped — a row per symbol per
// day is how a free tier fills up, and it buys nothing a journal needs.

import { col } from '../db.js';
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

export async function setThesis({ ticker, thesis, invalidation }) {
  const p = await getPosition(ticker);
  if (!p) return null;
  if (thesis != null) p.thesis = thesis;
  if (invalidation != null) p.invalidation = invalidation;
  return savePosition(p);
}

export async function ensureIndexes() {
  await col(POSITIONS).createIndex({ id: 1 }, { unique: true });
  await col(POSITIONS).createIndex({ ticker: 1 });
}
