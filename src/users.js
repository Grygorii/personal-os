import { col, rawCol, USER_COLLECTIONS } from './db.js';
import { config } from './config.js';
import { encrypt, decrypt, isEncryptionReady, maskKey } from './crypto.js';

// The tenant model. Today the bot serves one person; this makes "who is this?" an explicit,
// answerable question everywhere, which is the whole foundation of multi-tenant. Nothing
// here changes single-user behaviour: the owner is always allowed, and while MULTI_TENANT
// is off, everyone else is simply recorded as pending and ignored.

// Price tiers (€/month). 'trial' = the free first stretch, no key needed.
export const TIERS = {
  trial: { label: 'Trial', price: 0, byok: false, deep: false },
  supporter: { label: 'Supporter', price: 3, byok: true, deep: false }, // brings their own key
  standard: { label: 'Standard', price: 6, byok: false, deep: false }, // we cover a fast model
  deep: { label: 'Deep', price: 9, byok: false, deep: true }, // we cover the strongest model
};

const TRIAL_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;

function isOwner(chatId) {
  return !!config.telegramChatId && String(chatId) === String(config.telegramChatId);
}

// Get the user, creating the record on first contact. The owner is always active; anyone
// else starts 'pending' and must be approved (allowlist), so the door is shut by default.
export async function ensureUser({ chatId, name = '', username = '' }) {
  const id = String(chatId);
  const existing = await col('users').findOne({ _id: id });
  if (existing) {
    await col('users').updateOne({ _id: id }, { $set: { lastSeen: new Date() } });
    return existing;
  }
  const owner = isOwner(id);
  const doc = {
    _id: id,
    chatId: id,
    name,
    username,
    role: owner ? 'owner' : 'member',
    // What this person's bot IS. New people get the focused book product; the full life OS
    // stays in the code, just hidden. The owner keeps everything.
    product: owner ? 'full' : 'books',
    status: owner ? 'active' : 'pending',
    tier: owner ? 'owner' : 'trial',
    trialEndsAt: owner ? null : new Date(Date.now() + TRIAL_DAYS * DAY),
    tz: config.timezone,
    llm: null, // { provider, keyEnc } once they bring their own
    createdAt: new Date(),
    lastSeen: new Date(),
  };
  await col('users').insertOne(doc);
  if (!owner) console.log(`[users] new pending user ${id} (${name || username || 'unknown'})`);
  return doc;
}

// May this user talk to the bot right now?
export function isAllowed(user) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (!config.multiTenant) return false; // doors closed until explicitly opened
  return user.status === 'active';
}

export async function approve(chatId, tier = 'trial') {
  await col('users').updateOne({ _id: String(chatId) }, { $set: { status: 'active', tier, approvedAt: new Date() } });
}

export async function block(chatId) {
  await col('users').updateOne({ _id: String(chatId) }, { $set: { status: 'blocked' } });
}

export async function setTier(chatId, tier) {
  if (!TIERS[tier] && tier !== 'owner') throw new Error(`unknown tier: ${tier}`);
  await col('users').updateOne({ _id: String(chatId) }, { $set: { tier, tierSince: new Date() } });
}

export async function listUsers() {
  return col('users').find().sort({ createdAt: 1 }).toArray();
}

// Paginated queries — the admin surface has to stay usable whether there are 3 people
// waiting or 3,000, so we never load the whole table to show one screen.
export async function countByStatus() {
  // Counted in the database, not by loading every user into memory.
  const [active, pending, blocked] = await Promise.all([
    col('users').countDocuments({ status: 'active' }),
    col('users').countDocuments({ status: 'pending' }),
    col('users').countDocuments({ status: 'blocked' }),
  ]);
  return { active, pending, blocked };
}

export async function listByStatus(status, { skip = 0, limit = 5 } = {}) {
  const [rows, total] = await Promise.all([
    col('users').find({ status }).sort({ createdAt: 1 }).skip(skip).limit(limit).toArray(),
    col('users').countDocuments({ status }),
  ]);
  return { rows, total };
}

// ---------- their own AI key (BYOK) ----------

// Stored encrypted; the plaintext exists only in memory for the duration of a call.
export async function setUserKey(chatId, provider, plainKey) {
  if (!isEncryptionReady()) throw new Error('ENCRYPTION_KEY not set on the server');
  if (!['anthropic', 'gemini'].includes(provider)) throw new Error('unknown provider');
  await col('users').updateOne(
    { _id: String(chatId) },
    { $set: { llm: { provider, keyEnc: encrypt(plainKey), hint: maskKey(plainKey), setAt: new Date() } } }
  );
}

export async function clearUserKey(chatId) {
  await col('users').updateOne({ _id: String(chatId) }, { $set: { llm: null } });
}

// Which provider/key should serve this user's calls? Returns null to mean "use the
// server's own configured provider" (owner, trial, and the paid done-for-you tiers).
export function llmFor(user) {
  if (!user?.llm?.keyEnc) return null;
  try {
    return { provider: user.llm.provider, apiKey: decrypt(user.llm.keyEnc) };
  } catch (e) {
    console.error(`[users] could not decrypt key for ${user._id}: ${e.message}`);
    return null;
  }
}

export function trialExpired(user) {
  return !!(user?.tier === 'trial' && user.trialEndsAt && Date.now() > new Date(user.trialEndsAt).getTime());
}

// ---------- timezone & scheduling ----------

export function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function setTimezone(chatId, tz) {
  if (!validTimezone(tz)) throw new Error('unknown timezone');
  await col('users').updateOne({ _id: String(chatId) }, { $set: { tz } });
}

// Their local calendar date and time — the basis for firing check-ins in their own morning.
export function localNow(tz) {
  const now = new Date();
  const zone = validTimezone(tz) ? tz : config.timezone;
  const date = now.toLocaleDateString('en-CA', { timeZone: zone }); // YYYY-MM-DD
  const [hour, minute] = now
    .toLocaleTimeString('en-GB', { timeZone: zone, hour12: false, hour: '2-digit', minute: '2-digit' })
    .split(':')
    .map(Number);
  const dow = new Date(now.toLocaleString('en-US', { timeZone: zone })).getDay(); // 0=Sun
  return { date, hour, minute, dow };
}

// Has this agent already run for this user on their local day? (Prevents the minute-tick
// scheduler from firing the same check-in repeatedly.)
export function alreadyRan(user, agentId, localDate) {
  return user?.lastRuns?.[agentId] === localDate;
}

export async function recordRun(chatId, agentId, localDate) {
  await col('users').updateOne({ _id: String(chatId) }, { $set: { [`lastRuns.${agentId}`]: localDate } });
}

// ---------- onboarding ----------

export async function setProduct(chatId, product) {
  if (!['books', 'full'].includes(product)) throw new Error('unknown product');
  await col('users').updateOne({ _id: String(chatId) }, { $set: { product } });
}

export async function markOnboarded(chatId) {
  await col('users').updateOne({ _id: String(chatId) }, { $set: { onboardedAt: new Date() } });
}

// Tell a pending person once that they're on the list — then stay quiet (no spam surface).
export async function markNotified(chatId) {
  await col('users').updateOne({ _id: String(chatId) }, { $set: { notifiedPending: true } });
}

// ---------- their data: take it or delete it ----------

export async function exportUserData(userId) {
  const out = { exportedAt: new Date().toISOString(), userId, collections: {} };
  const account = await rawCol('users').findOne({ _id: String(userId) });
  if (account) {
    const { llm, ...safe } = account; // never export the stored key, even encrypted
    out.account = { ...safe, llmConfigured: !!llm };
  }
  for (const name of USER_COLLECTIONS) {
    const rows = await rawCol(name).find({ userId: String(userId) }).toArray();
    if (rows.length) out.collections[name] = rows;
  }
  return out;
}

export async function deleteUserData(userId, { keepAccount = false } = {}) {
  const removed = {};
  for (const name of USER_COLLECTIONS) {
    const r = await rawCol(name).deleteMany({ userId: String(userId) });
    if (r.deletedCount) removed[name] = r.deletedCount;
  }
  await rawCol('meta').deleteOne({ _id: `book_recs:${userId}` });
  if (!keepAccount) await rawCol('users').deleteOne({ _id: String(userId) });
  return removed;
}

// ---------- rate limiting ----------
// In-memory sliding window: cheap, per-process, and resets on deploy — which is fine, since
// its job is stopping a runaway loop or a spammer, not long-term accounting.
const hits = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;

export function rateLimit(userId, max = MAX_PER_WINDOW) {
  const now = Date.now();
  const recent = (hits.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= max) {
    hits.set(userId, recent);
    return false; // over the limit
  }
  recent.push(now);
  hits.set(userId, recent);
  return true;
}
