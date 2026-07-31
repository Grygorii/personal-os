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
  // Optional launch gate: when set, ONLY these addresses may sign in with Google. More can
  // be added from /admin without a redeploy. Empty = open to anyone.
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
if (!config.anthropicKey && !config.geminiKey) {
  console.warn('[config] No LLM key set — need ANTHROPIC_API_KEY or GEMINI_API_KEY');
}
