import crypto from 'crypto';
import { config } from './config.js';

// Encryption for the one thing we must never store in the clear: a tenant's own AI API key.
// AES-256-GCM (authenticated — tampering is detected, not silently decrypted to garbage).
// The master key lives ONLY in the environment (Railway), never in Mongo and never in git,
// so a database leak alone cannot expose anyone's key.

function masterKey() {
  const raw = config.encryptionKey;
  if (!raw) return null;
  // Accept either 64 hex chars (a proper 32-byte key) or any passphrase, hashed to 32 bytes.
  return /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : crypto.createHash('sha256').update(raw).digest();
}

export function isEncryptionReady() {
  return !!masterKey();
}

// Generate a key to paste into ENCRYPTION_KEY. Run: node -e "import('./src/crypto.js').then(m=>console.log(m.newMasterKey()))"
export function newMasterKey() {
  return crypto.randomBytes(32).toString('hex');
}

export function encrypt(plaintext) {
  const k = masterKey();
  if (!k) throw new Error('ENCRYPTION_KEY is not set — refusing to store a secret in the clear');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  // Versioned so the format can change later without guessing.
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function decrypt(blob) {
  const k = masterKey();
  if (!k) throw new Error('ENCRYPTION_KEY is not set');
  const [v, iv, tag, data] = String(blob || '').split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('bad ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

// For showing a key back to its owner without revealing it: "sk-ant-…4f2a".
export function maskKey(plaintext) {
  const s = String(plaintext || '');
  if (s.length < 12) return '••••';
  return `${s.slice(0, 7)}…${s.slice(-4)}`;
}
