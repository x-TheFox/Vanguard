/**
 * Shared Utility Tests
 *
 * Tests correlation ID generation, secret redaction, path sanitization,
 * validation functions, sleep, and retry with backoff.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCorrelationId,
  redactSecrets,
  sanitizePath,
  isApplicationKey,
  isClientKey,
  isValidUuid,
  sleep,
  withRetry,
} from '../utils/index.js';

// ── Correlation ID ──────────────────────────────────────────────

describe('createCorrelationId', () => {
  it('should generate unique IDs', () => {
    const id1 = createCorrelationId();
    const id2 = createCorrelationId();
    assert.notStrictEqual(id1, id2);
  });

  it('should produce UUID v4 format', () => {
    const id = createCorrelationId();
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    assert.ok(uuidRegex.test(id), `ID "${id}" is not a valid UUID v4`);
  });
});

// ── Secret Redaction ────────────────────────────────────────────

describe('redactSecrets', () => {
  it('should redact ptla_ tokens', () => {
    const result = redactSecrets('Key: ptla_abc123xyz');
    assert.ok(result.includes('ptla_****REDACTED****'));
    assert.ok(!result.includes('ptla_abc123xyz'));
  });

  it('should redact ptlc_ tokens', () => {
    const result = redactSecrets('Key: ptlc_def456uvw');
    assert.ok(result.includes('ptlc_****REDACTED****'));
    assert.ok(!result.includes('ptlc_def456uvw'));
  });

  it('should redact sk- tokens', () => {
    const result = redactSecrets('Key: sk-abcdef123456');
    assert.ok(result.includes('sk-****REDACTED****'));
    assert.ok(!result.includes('sk-abcdef123456'));
  });

  it('should redact xai- tokens', () => {
    const result = redactSecrets('Key: xai-xyz789abc');
    assert.ok(result.includes('xai-****REDACTED****'));
    assert.ok(!result.includes('xai-xyz789abc'));
  });

  it('should redact gsk_ tokens', () => {
    const result = redactSecrets('Key: gsk_mnopqr123');
    assert.ok(result.includes('gsk_****REDACTED****'));
    assert.ok(!result.includes('gsk_mnopqr123'));
  });

  it('should redact ENCRYPTION_KEY= values', () => {
    const result = redactSecrets('ENCRYPTION_KEY=abcdef1234567890abcdef1234567890');
    assert.ok(result.includes('ENCRYPTION_KEY=****REDACTED****'));
    assert.ok(!result.includes('abcdef1234567890'));
  });

  it('should leave non-secret content unchanged', () => {
    const input = 'This is a normal log message with no secrets';
    assert.strictEqual(redactSecrets(input), input);
  });

  it('should redact multiple secrets in one string', () => {
    const result = redactSecrets('ptla_key1 and ptlc_key2 and sk-key3');
    assert.ok(!result.includes('ptla_key1'));
    assert.ok(!result.includes('ptlc_key2'));
    assert.ok(!result.includes('sk-key3'));
    assert.ok(result.includes('ptla_****REDACTED****'));
    assert.ok(result.includes('ptlc_****REDACTED****'));
    assert.ok(result.includes('sk-****REDACTED****'));
  });
});

// ── Path Sanitization ───────────────────────────────────────────

describe('sanitizePath (shared)', () => {
  it('should reject paths with ".."', () => {
    assert.throws(() => sanitizePath('../etc/passwd'), { message: /Path traversal/ });
    assert.throws(() => sanitizePath('foo/../../bar'), { message: /Path traversal/ });
  });

  it('should normalize backslashes to forward slashes', () => {
    assert.strictEqual(sanitizePath('world\\level.dat'), 'world/level.dat');
  });

  it('should collapse multiple slashes', () => {
    assert.strictEqual(sanitizePath('world//level.dat'), 'world/level.dat');
  });
});

// ── Validation Functions ────────────────────────────────────────

describe('isApplicationKey', () => {
  it('should return true for ptla_ prefixed keys', () => {
    assert.strictEqual(isApplicationKey('ptla_abc123'), true);
  });

  it('should return false for non-ptla_ keys', () => {
    assert.strictEqual(isApplicationKey('ptlc_abc123'), false);
    assert.strictEqual(isApplicationKey('sk-abc123'), false);
    assert.strictEqual(isApplicationKey('regular_string'), false);
  });
});

describe('isClientKey', () => {
  it('should return true for ptlc_ prefixed keys', () => {
    assert.strictEqual(isClientKey('ptlc_abc123'), true);
  });

  it('should return false for non-ptlc_ keys', () => {
    assert.strictEqual(isClientKey('ptla_abc123'), false);
    assert.strictEqual(isClientKey('sk-abc123'), false);
    assert.strictEqual(isClientKey('regular_string'), false);
  });
});

describe('isValidUuid', () => {
  it('should return true for valid UUID v4', () => {
    assert.strictEqual(isValidUuid('550e8400-e29b-41d4-a716-446655440000'), true);
  });

  it('should return false for invalid UUIDs', () => {
    assert.strictEqual(isValidUuid('not-a-uuid'), false);
    assert.strictEqual(isValidUuid('550e8400-e29b-51d4-a716-446655440000'), false); // version 5
    assert.strictEqual(isValidUuid('550e8400-e29b-41d4-c716-446655440000'), false); // invalid variant
    assert.strictEqual(isValidUuid(''), false);
  });
});

// ── Sleep Utility ───────────────────────────────────────────────

describe('sleep', () => {
  it('should resolve after the specified duration', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `Sleep was too short: ${elapsed}ms`); // Allow small variance
  });
});

// ── Retry with Backoff ──────────────────────────────────────────

describe('withRetry', () => {
  it('should return result on first attempt if successful', async () => {
    const result = await withRetry(
      () => Promise.resolve(42),
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    );
    assert.strictEqual(result, 42);
  });

  it('should retry on failure and eventually succeed', async () => {
    let attempt = 0;
    const result = await withRetry(
      () => {
        attempt++;
        if (attempt < 3) throw new Error('not yet');
        return Promise.resolve('success');
      },
      { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 50 },
    );
    assert.strictEqual(result, 'success');
    assert.strictEqual(attempt, 3);
  });

  it('should throw after max attempts exceeded', async () => {
    await assert.rejects(
      () =>
        withRetry(
          () => Promise.reject(new Error('always fails')),
          { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
        ),
      { message: 'always fails' },
    );
  });

  it('should respect shouldRetry callback', async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        withRetry(
          () => {
            attempts++;
            throw new Error('non-retryable');
          },
          {
            maxAttempts: 5,
            baseDelayMs: 10,
            maxDelayMs: 50,
            shouldRetry: (err) => !(err instanceof Error && err.message === 'non-retryable'),
          },
        ),
      { message: 'non-retryable' },
    );
    // Should only attempt once because shouldRetry returns false
    assert.strictEqual(attempts, 1);
  });
});
