// Verifying that a Mini App request really came from Telegram.
//
// Lifted out of webserver.js so Pocket can use it without importing the whole of Kept. The
// implementation is unchanged and deliberately so — it is the only thing standing between a
// public Railway URL and a household's finances, and this is not the place for a fresh attempt.
//
// https://core.telegram.org/bots/webapps#validating-data

import crypto from 'crypto';

const INITDATA_TTL_MS = 24 * 60 * 60 * 1000; // a captured initData must not work forever

/** Returns the parsed Telegram user if the signature is valid and fresh, else null. */
export function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const check = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  // Constant-time compare: a plain !== leaks how much of the hash matched via timing.
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  // Freshness: without this, one captured initData string is a permanent credential.
  const authDate = Number(params.get('auth_date')) * 1000;
  if (!authDate || Date.now() - authDate > INITDATA_TTL_MS) return null;
  try {
    return JSON.parse(params.get('user') || '{}');
  } catch {
    return null;
  }
}
