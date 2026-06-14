import { MongoClient } from 'mongodb';
import { config } from './config.js';

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

export function col(name) {
  if (!db) throw new Error('DB not connected. Call connect() first.');
  return db.collection(name);
}

// The single shared-memory document every agent reads.
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
