import { connect, rawCol, USER_COLLECTIONS } from './db.js';
import { config } from './config.js';

// One-time (idempotent) migration to the multi-tenant data layer: stamp every existing
// document with the owner's userId, and give the old singletons per-user ids
// ('me' → 'me:<owner>'). Safe to run repeatedly — already-migrated docs are skipped.
//
//   npm run migrate

const SCOPED = USER_COLLECTIONS;

// Collections whose single document used a fixed string _id.
const SINGLETONS = { profile: 'me', system: 'state', reading: 'current', english: 'state' };

async function main() {
  await connect();
  const owner = String(config.telegramChatId || '').trim();
  if (!owner) throw new Error('TELEGRAM_CHAT_ID must be set — it identifies the owner');
  console.log(`[migrate] owner = ${owner}\n`);

  let stamped = 0;
  let moved = 0;

  for (const name of SCOPED) {
    const c = rawCol(name);
    const total = await c.countDocuments({});
    if (!total) continue;

    // 1) Re-key the singleton document, if this collection has one. _id is immutable in
    //    Mongo, so the document is re-inserted under its new id and the old one removed.
    const singleId = SINGLETONS[name];
    if (singleId) {
      const old = await c.findOne({ _id: singleId });
      if (old) {
        const next = { ...old, _id: `${singleId}:${owner}`, userId: owner };
        await c.insertOne(next);
        await c.deleteOne({ _id: singleId });
        moved++;
        console.log(`  ${name}: '${singleId}' → '${singleId}:${owner}'`);
      }
    }

    // 2) Everything without a userId belongs to the owner (he was the only user).
    const res = await c.updateMany({ userId: { $exists: false } }, { $set: { userId: owner } });
    stamped += res.modifiedCount;
    const missing = await c.countDocuments({ userId: { $exists: false } });
    console.log(`  ${name.padEnd(20)} ${String(total).padStart(5)} docs · stamped ${String(res.modifiedCount).padStart(5)} · unowned left ${missing}`);
  }

  // The cached book recommendations live in the global meta collection, so they need the
  // user in the key itself.
  const meta = rawCol('meta');
  const recs = await meta.findOne({ _id: 'book_recs' });
  if (recs) {
    await meta.insertOne({ ...recs, _id: `book_recs:${owner}` });
    await meta.deleteOne({ _id: 'book_recs' });
    console.log(`  meta: 'book_recs' → 'book_recs:${owner}'`);
  }

  console.log(`\n[migrate] done — ${stamped} documents stamped, ${moved} singletons re-keyed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err);
  process.exit(1);
});
