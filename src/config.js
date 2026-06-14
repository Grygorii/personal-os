import 'dotenv/config';

export const config = {
  mongoUri: process.env.MONGO_URI,
  dbName: process.env.DB_NAME || 'personal_os',
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID, // your own numeric chat id
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
