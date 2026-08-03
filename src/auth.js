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

// ---------- Google ----------
// Verified against Google's own tokeninfo endpoint rather than by hand: no dependency, no
// JWKS caching to get wrong, and Google checks the signature and expiry for us. We still
// check `aud` ourselves — without that, a token minted for ANY other Google app would be
// accepted here, which is the classic mistake.
export async function verifyGoogleToken(idToken) {
  if (!idToken || !config.googleClientId) return null;
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) return null;
    const t = await res.json();
    if (t.aud !== config.googleClientId) return null; // token was for a different app
    if (!t.sub) return null;
    if (Number(t.exp) * 1000 < Date.now()) return null;
    if (t.email && t.email_verified === 'false') return null;
    return { sub: String(t.sub), name: t.given_name || t.name || '', email: t.email || '' };
  } catch (e) {
    console.error('[auth] google verify failed:', e.message);
    return null;
  }
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

// Which shared result brought them here. Set when they land on /app?r=<code>, read once
// they've signed in, then thrown away — the gap between arriving and having an account is
// where attribution used to be lost entirely.
const REF_TTL_S = 60 * 60 * 24 * 7;
export const refCookie = (code) =>
  `kept_ref=${encodeURIComponent(code)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${REF_TTL_S}`;
export const clearedRefCookie = 'kept_ref=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

// Who wrote in, when they have no account. The most useful thing anyone can tell us is
// "I couldn't sign in", and that sentence by definition comes from a stranger — so a message
// needs no account, and this is the only thread they'd have to read the answer.
//
// Set ONLY when a message is actually sent, never for browsing, so "we don't track people
// who are just reading" stays literally true. A year, because a reply might take a day and
// they might not open the app again for a month.
const MAIL_TTL_S = 60 * 60 * 24 * 365;
export const mailCookie = (id) =>
  `kept_mail=${encodeURIComponent(id)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAIL_TTL_S}`;
