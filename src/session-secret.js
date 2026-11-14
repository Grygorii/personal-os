// Keep existing valid signing material compatible; never use a public development secret.
export function sessionBase({ sessionSecret, encryptionKey, telegramToken } = {}) {
  const base = sessionSecret || encryptionKey || telegramToken;
  if (typeof base !== 'string' || base.length < 32) {
    throw new Error('Kept needs SESSION_SECRET (at least 32 characters), or an existing strong ENCRYPTION_KEY/TELEGRAM_BOT_TOKEN, before it can sign sessions.');
  }
  return base;
}
