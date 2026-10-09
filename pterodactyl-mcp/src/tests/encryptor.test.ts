/**
 * AES-256-GCM Encryptor Tests
 *
 * Verifies encryption/decryption roundtrip, nonce uniqueness,
 * hash consistency, and wrong-key rejection.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { encryptToken, decryptToken, hashToken } from '../auth/encryptor.js';

// Set up a deterministic ENCRYPTION_KEY for tests
const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const WRONG_KEY = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

before(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
});

describe('encryptToken / decryptToken', () => {
  it('should roundtrip: encrypt then decrypt returns original plaintext', () => {
    const plaintext = 'ptlc_testClientApiKey123456';
    const { encrypted, nonce, tag } = encryptToken(plaintext);
    const decrypted = decryptToken(encrypted, nonce, tag);
    assert.strictEqual(decrypted, plaintext);
  });

  it('should produce different nonces for the same plaintext', () => {
    const plaintext = 'ptla_appKeySamePlaintext';
    const result1 = encryptToken(plaintext);
    const result2 = encryptToken(plaintext);

    // Nonces must differ (random IV)
    assert.notStrictEqual(result1.nonce, result2.nonce);

    // Ciphertext should also differ due to different IVs
    assert.notStrictEqual(result1.encrypted, result2.encrypted);

    // Both must still decrypt correctly
    assert.strictEqual(decryptToken(result1.encrypted, result1.nonce, result1.tag), plaintext);
    assert.strictEqual(decryptToken(result2.encrypted, result2.nonce, result2.tag), plaintext);
  });

  it('should throw when ENCRYPTION_KEY is not set', () => {
    const saved = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    assert.throws(() => encryptToken('test'), { message: /ENCRYPTION_KEY/ });
    process.env.ENCRYPTION_KEY = saved;
  });

  it('should throw when ENCRYPTION_KEY is wrong length', () => {
    const saved = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'tooshort';
    assert.throws(() => encryptToken('test'), { message: /32 bytes/ });
    process.env.ENCRYPTION_KEY = saved;
  });
});

describe('decryptToken — wrong key', () => {
  it('should fail to decrypt with a different key', () => {
    const plaintext = 'ptlc_sensitiveData789';
    const { encrypted, nonce, tag } = encryptToken(plaintext);

    // Switch to wrong key before decrypting
    process.env.ENCRYPTION_KEY = WRONG_KEY;
    assert.throws(() => decryptToken(encrypted, nonce, tag));

    // Restore correct key
    process.env.ENCRYPTION_KEY = TEST_KEY;
  });
});

describe('hashToken', () => {
  it('should produce consistent hashes for the same input', () => {
    const token = 'ptlc_hashTestToken999';
    const hash1 = hashToken(token);
    const hash2 = hashToken(token);
    assert.strictEqual(hash1, hash2);
  });

  it('should produce different hashes for different inputs', () => {
    const hash1 = hashToken('ptlc_token_aaa');
    const hash2 = hashToken('ptlc_token_bbb');
    assert.notStrictEqual(hash1, hash2);
  });

  it('should produce a 64-char hex string (SHA-256)', () => {
    const hash = hashToken('ptlc_anything');
    assert.ok(/^[0-9a-f]{64}$/.test(hash), `Hash "${hash}" is not a valid SHA-256 hex string`);
  });
});
