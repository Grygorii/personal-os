import 'dotenv/config';

// Guard against sloppy pastes — e.g. a key with a second line glued on. Take just the
// first non-empty line and trim, so a stray newline can't corrupt an HTTP header and
// crash every API call (which is exactly what happened once: ANTHROPIC_API_KEY had
// "CLAUDE_MODEL=..." pasted onto a second line).
const oneLine = (v) =>
  (v || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length) || '';

export const config = {
  mongoUri: oneLine(process.env.MONGO_URI),
  dbName: oneLine(process.env.DB_NAME) || 'personal_os',
  // LLM_PROVIDER picks who handles everyday coaching: 'gemini' (cheap/free tier) or
  // 'anthropic'. Deep work (portraits, exams) still prefers Claude when a key exists.
  provider: (oneLine(process.env.LLM_PROVIDER) || 'anthropic').toLowerCase(),
  anthropicKey: oneLine(process.env.ANTHROPIC_API_KEY),
  // Web push identity. Optional: if unset, a keypair is generated once and kept in the
  // database, so notifications work without anybody having to remember a deploy step.
  vapidPublic: oneLine(process.env.VAPID_PUBLIC) || '',
  vapidPrivate: oneLine(process.env.VAPID_PRIVATE) || '',
  model: oneLine(process.env.CLAUDE_MODEL) || 'claude-sonnet-4-6',
  deepModel: oneLine(process.env.DEEP_MODEL) || oneLine(process.env.CLAUDE_MODEL) || 'claude-sonnet-4-6',
  geminiKey: oneLine(process.env.GEMINI_API_KEY),
  geminiModel: oneLine(process.env.GEMINI_MODEL) || 'gemini-2.5-flash',
  telegramToken: oneLine(process.env.TELEGRAM_BOT_TOKEN),
  telegramChatId: oneLine(process.env.TELEGRAM_CHAT_ID), // the owner's numeric chat id
  timezone: process.env.TZ || 'Europe/Dublin',
  // Master key for encrypting tenants' own AI keys at rest. Env only — never in Mongo/git.
  encryptionKey: oneLine(process.env.ENCRYPTION_KEY),
  // Multi-tenant switch. Off = only the owner may use the bot (current behaviour).
  multiTenant: oneLine(process.env.MULTI_TENANT) === 'true',
  // With the doors open, let people straight in (they land on trust level 0 with a small
  // daily allowance). Set to 'false' to go back to approve-first.
  autoAccept: oneLine(process.env.AUTO_ACCEPT) !== 'false',
  // Public URL of the Mini App (used for the tappable buttons in chat).
  appUrl: (oneLine(process.env.APP_URL) || 'https://readkept.com').replace(/\/+$/, ''),
  // Discovered from Telegram at boot (see index.js) — used to build share deep links.
  botUsername: oneLine(process.env.BOT_USERNAME),
  // Google Sign-In (console.cloud.google.com → Credentials → OAuth client, Web). Optional:
  // without it the Google button simply isn't offered.
  googleClientId: oneLine(process.env.GOOGLE_CLIENT_ID),
  // The owner's Google address — signing in with it lands in the OWNER account rather than
  // creating a second one. Overridable so a self-hoster can make it theirs.
  ownerEmail: (oneLine(process.env.OWNER_EMAIL) || 'grisha.kinzerskyi@gmail.com').toLowerCase(),
  // The app is OPEN: anyone may sign in with Google. This is only about who can USE it —
  // administering it is a separate thing entirely, decided by `role: owner`.
  // Set INVITE_ONLY=true to run a closed beta instead; then only the owner, ALLOWED_EMAILS
  // and addresses invited from /admin can get in.
  inviteOnly: oneLine(process.env.INVITE_ONLY) === 'true',
  // ---- Steward (the investing bot) ----
  // Market data. Without a key the steward falls back to end-of-day prices and has no
  // dividend numbers at all, which for an income strategy is most of what matters.
  marketKey: oneLine(process.env.MARKET_API_KEY),
  marketProvider: oneLine(process.env.MARKET_PROVIDER),
  // What his stock picking is measured against. He already owns a global index portfolio he
  // does not touch; anything he picks by hand has to beat it or it is a hobby he is paying
  // for. Default is a world tracker, so the comparison is "the boring thing", not the S&P.
  benchmark: oneLine(process.env.BENCHMARK) || 'URTH',
  // ---- Pocket (the household's money) ----
  // What everything totals in. He earns and spends in euro; the portfolio is in dollars and
  // the deposits and the apartment are in Egyptian pounds, so one base currency has to be
  // named or "how much do I have" has no answer.
  baseCurrency: (oneLine(process.env.BASE_CURRENCY) || 'EUR').toUpperCase(),
  // Overridable so a different rate provider can be swapped in without a code change.
  fxUrl: oneLine(process.env.FX_URL),
  allowedEmails: oneLine(process.env.ALLOWED_EMAILS)
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
};

// Warn (don't crash) on missing essentials so `npm run seed` etc. still load.
const required = {
  MONGO_URI: config.mongoUri,
  TELEGRAM_BOT_TOKEN: config.telegramToken,
};
for (const [key, value] of Object.entries(required)) {
  if (!value) console.warn(`[config] Missing env var: ${key}`);
}

// This file is shared by three apps and only two of them talk to a model, so the LLM warning
// cannot live here unconditionally. Printed on every boot it becomes noise at best — and at
// worst it is read as a cause: Pocket crashed on a missing MONGO_URI while announcing "No LLM
// key set", and the obvious reading of those two lines together sent a debugging session off
// after an API key the app never uses. A warning that is not true of the running process is
// worse than no warning, because someone will act on it.
export function warnIfNoLlmKey() {
  if (!config.anthropicKey && !config.geminiKey) {
    console.warn('[config] No LLM key set — need ANTHROPIC_API_KEY or GEMINI_API_KEY');
  }
}
