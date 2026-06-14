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
  anthropicKey: oneLine(process.env.ANTHROPIC_API_KEY),
  model: oneLine(process.env.CLAUDE_MODEL) || 'claude-sonnet-4-6',
  telegramToken: oneLine(process.env.TELEGRAM_BOT_TOKEN),
  telegramChatId: oneLine(process.env.TELEGRAM_CHAT_ID), // your own numeric chat id
  timezone: process.env.TZ || 'Europe/Dublin',
};

// Warn (don't crash) on missing essentials so `npm run seed` etc. still load.
const required = {
  MONGO_URI: config.mongoUri,
  ANTHROPIC_API_KEY: config.anthropicKey,
  TELEGRAM_BOT_TOKEN: config.telegramToken,
};
for (const [key, value] of Object.entries(required)) {
  if (!value) console.warn(`[config] Missing env var: ${key}`);
}
