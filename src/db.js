import { MongoClient } from 'mongodb';
import { config } from './config.js';
import { uid } from './ctx.js';

let client;
let db;

export async function connect() {
  if (db) return db;
  client = new MongoClient(config.mongoUri);
  await client.connect();
  db = client.db(config.dbName);
  console.log(`[db] connected to "${config.dbName}"`);
  return db;
}

// Collections that are the same for everyone. Everything else is per-user — the default is
// SCOPED on purpose, so a collection added later is private unless deliberately shared.
const GLOBAL_COLLECTIONS = new Set([
  'users', // the tenant registry itself
  'meta', // boot marker and other server-wide state
  'agents', // the schedule definitions; the runtime fans them out per user
]);

// Every collection that holds personal data. The single source of truth for migration,
// export and deletion — if a new user collection is added, add it here too.
export const USER_COLLECTIONS = [
  'logs', 'conversation', 'pursuits', 'snapshots', 'portraits', 'book_exams',
  'books', 'reading', 'system', 'profile', 'english', 'english_scores', 'english_words',
  'english_books', 'english_convo', 'english_breakdowns',
];

// Indexes that matter once there's more than one person: every user query filters on
// userId, and the admin queue filters on status. Without these, both do collection scans
// that get slower with every tenant. Safe and idempotent — Mongo skips existing indexes.
export async function ensureIndexes() {
  try {
    await rawCol('users').createIndex({ status: 1, createdAt: 1 });
    for (const name of USER_COLLECTIONS) await rawCol(name).createIndex({ userId: 1 });
    await rawCol('logs').createIndex({ userId: 1, ts: -1 });
    await rawCol('conversation').createIndex({ userId: 1, ts: -1 });
    console.log('[db] indexes ensured');
  } catch (err) {
    console.error('[db] index creation failed (continuing):', err.message);
  }
}

// Raw, unscoped access. Only for migrations and global collections — never for user data.
export function rawCol(name) {
  if (!db) throw new Error('DB not connected. Call connect() first.');
  return db.collection(name);
}

// Add the current user to a query. A fixed string _id (the old singletons 'me', 'state',
// 'current') becomes per-user — 'me' → 'me:488418318' — so every tenant has their own.
function scopeFilter(filter = {}) {
  const id = uid();
  const out = { ...filter, userId: id };
  if (typeof out._id === 'string' && !out._id.endsWith(`:${id}`)) out._id = `${out._id}:${id}`;
  return out;
}

function scopeDoc(doc = {}) {
  const id = uid();
  const out = { ...doc, userId: id };
  if (typeof out._id === 'string' && !out._id.endsWith(`:${id}`)) out._id = `${out._id}:${id}`;
  return out;
}

// On upsert Mongo copies the filter's equality fields into the new document, so userId is
// carried automatically. We only strip _id out of $set/$setOnInsert: the id now comes from
// the (scoped) filter, and re-assigning it would be an immutable-field error.
function scopeUpdate(update = {}) {
  const out = { ...update };
  const hasOperators = Object.keys(out).some((k) => k.startsWith('$'));
  if (!hasOperators) return scopeDoc(out); // whole-document replacement
  for (const op of ['$set', '$setOnInsert']) {
    if (out[op] && typeof out[op] === 'object' && '_id' in out[op]) {
      const copy = { ...out[op] };
      delete copy._id;
      if (Object.keys(copy).length) out[op] = copy;
      else delete out[op];
    }
  }
  return out;
}

// A thin per-user view of a collection. Only the methods this app actually uses are
// exposed — anything else must go through rawCol() deliberately.
function scoped(coll) {
  return {
    find: (filter = {}, options) => coll.find(scopeFilter(filter), options),
    findOne: (filter = {}, options) => coll.findOne(scopeFilter(filter), options),
    countDocuments: (filter = {}, options) => coll.countDocuments(scopeFilter(filter), options),
    insertOne: (doc, options) => coll.insertOne(scopeDoc(doc), options),
    updateOne: (filter, update, options) => coll.updateOne(scopeFilter(filter), scopeUpdate(update), options),
    deleteOne: (filter = {}, options) => coll.deleteOne(scopeFilter(filter), options),
    deleteMany: (filter = {}, options) => coll.deleteMany(scopeFilter(filter), options),
  };
}

export function col(name) {
  if (!db) throw new Error('DB not connected. Call connect() first.');
  const coll = db.collection(name);
  return GLOBAL_COLLECTIONS.has(name) ? coll : scoped(coll);
}

// The shared-memory document the coach reads (now one per user).
export async function getProfile() {
  return (await col('profile').findOne({ _id: 'me' })) || {};
}

// The universal timestamped event stream (water, sleep, book, essay, ...).
export async function logEvent(type, data = {}) {
  return col('logs').insertOne({ type, ...data, ts: new Date() });
}

// Count events of a type logged within the last `withinMs` milliseconds.
export async function recentCount(type, withinMs) {
  const since = new Date(Date.now() - withinMs);
  return col('logs').countDocuments({ type, ts: { $gte: since } });
}
