import crypto from 'crypto';
import { config } from './config.js';

// Signing in on the WEBSITE, so the installed app doesn't depend on Telegram being open.
// Telegram stays the identity provider — no passwords, no email — but the session lives in
// a cookie on our own domain.
//
// Note the two Telegram schemes are NOT the same:
//   Mini App initData → secret = HMAC_SHA256(botToken, "WebAppData")
//   Login Widget      → secret = SHA256(botToken)
// Using the wrong one silently rejects every login, so they're kept separate on purpose.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOGIN_MAX_AGE_S = 24 * 60 * 60; // a login payload older than a day is refused

export function verifyTelegramLogin(query, botToken = config.telegramToken) {
  if (!botToken) return null;
  const data = { ...query };
  const hash = data.hash;
  delete data.hash;
  if (!hash) return null;

  const dataCheckString = Object.keys(data)
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(hash), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // Freshness: a captured login link must not work forever.
  const authDate = Number(data.auth_date);
  if (!authDate || Date.now() / 1000 - authDate > LOGIN_MAX_AGE_S) return null;

  return { id: String(data.id), first_name: data.first_name || '', username: data.username || '' };
}

// ---------- sessions ----------
// A cookie the server signs and can verify without any storage lookup.

function sessionKey() {
  // Reuse the master key when present; otherwise derive from the bot token so sessions
  // still work before ENCRYPTION_KEY is set (it's a signing key, not an encryption key).
  const base = config.encryptionKey || config.telegramToken || 'insecure-dev-key';
  return crypto.createHash('sha256').update(`session:${base}`).digest();
}

export function createSession(userId) {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = `${userId}.${expires}`;
  const sig = crypto.createHmac('sha256', sessionKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function readSession(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [userId, expires, sig] = parts;
  const expected = crypto.createHmac('sha256', sessionKey()).update(`${userId}.${expires}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(expires) < Date.now()) return null;
  return userId;
}

export function parseCookies(header = '') {
  return String(header)
    .split(';')
    .map((c) => c.trim())
    .filter(Boolean)
    .reduce((acc, c) => {
      const i = c.indexOf('=');
      if (i > 0) acc[c.slice(0, i)] = decodeURIComponent(c.slice(i + 1));
      return acc;
    }, {});
}

export function sessionCookie(token) {
  return `kept_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export const clearedCookie = 'kept_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
