/**
 * AES-256-GCM Encryption/Decryption for Pterodactyl API tokens
 *
 * Tokens are encrypted at rest in the database using AES-256-GCM.
 * The encryption key is loaded from the ENCRYPTION_KEY environment variable.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

/** Get the encryption key from environment (32 bytes hex = 256 bits) */
function getEncryptionKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex) throw new Error('ENCRYPTION_KEY environment variable is not set');
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  return key;
}

/** Encrypt a plaintext token using AES-256-GCM. Returns { encrypted, nonce, tag } as hex strings */
export function encryptToken(plaintext: string): { encrypted: string; nonce: string; tag: string } {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    nonce: iv.toString('hex'),
    tag,
  };
}

/** Decrypt a token that was encrypted with encryptToken */
export function decryptToken(encrypted: string, nonce: string, tag: string): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(nonce, 'hex');
  const authTag = Buffer.from(tag, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/** Compute SHA-256 hash of a token for lookup without decryption */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
