/**
 * Shared utility functions for EdenVanguard
 */

import { randomUUID } from 'node:crypto';
import type { CorrelationId } from '../types/index.js';

// ── Correlation ID Generation ───────────────────────────────

/** Generate a new correlation ID for IPC message tracing */
export function createCorrelationId(): CorrelationId {
  return randomUUID() as CorrelationId;
}

// ── Secret Redaction ────────────────────────────────────────

/** Patterns that should be redacted from logs and output */
const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /ptla_[A-Za-z0-9]+/g, replacement: 'ptla_****REDACTED****' },
  { pattern: /ptlc_[A-Za-z0-9]+/g, replacement: 'ptlc_****REDACTED****' },
  { pattern: /sk-[A-Za-z0-9]+/g, replacement: 'sk-****REDACTED****' },
  { pattern: /xai-[A-Za-z0-9]+/g, replacement: 'xai-****REDACTED****' },
  { pattern: /gsk_[A-Za-z0-9]+/g, replacement: 'gsk_****REDACTED****' },
  { pattern: /ENCRYPTION_KEY[=:]\s*\S+/gi, replacement: 'ENCRYPTION_KEY=****REDACTED****' },
];

/** Redact secrets from a string (for logging safety) */
export function redactSecrets(input: string): string {
  let result = input;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ── Path Sanitization ───────────────────────────────────────

/** Sanitize a file path to prevent directory traversal attacks */
export function sanitizePath(path: string): string {
  // Reject paths containing directory traversal
  if (path.includes('..')) {
    throw new Error(`Path traversal detected: "${path}"`);
  }

  // Normalize the path
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');

  // Ensure path is relative or rooted at /
  if (normalized.startsWith('/')) {
    return normalized;
  }

  return normalized;
}

// ── Validation ──────────────────────────────────────────────

/** Validate that a string looks like a Pterodactyl Application API key */
export function isApplicationKey(key: string): boolean {
  return key.startsWith('ptla_');
}

/** Validate that a string looks like a Pterodactyl Client API key */
export function isClientKey(key: string): boolean {
  return key.startsWith('ptlc_');
}

/** Validate that a string is a valid UUID */
export function isValidUuid(id: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

// ── Sleep Utility ───────────────────────────────────────────

/** Sleep for a specified number of milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Retry Utility ───────────────────────────────────────────

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry?: (error: unknown) => boolean;
}

/** Execute a function with exponential backoff retry */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, shouldRetry } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (shouldRetry && !shouldRetry(error)) {
        throw error;
      }

      if (attempt === maxAttempts) {
        break;
      }

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const jitter = delay * 0.1 * Math.random();
      await sleep(delay + jitter);
    }
  }

  throw lastError;
}
