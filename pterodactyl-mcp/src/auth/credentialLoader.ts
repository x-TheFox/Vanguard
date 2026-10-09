/**
 * Credential Loader — Loads and caches Pterodactyl API credentials
 *
 * Reads encrypted credentials from the `ptero_credentials` database table,
 * decrypts them, and maintains an in-memory cache. Supports reloading via
 * SIGUSR1 or NATS signal.
 *
 * Key features:
 * - Load all active credentials from DB on startup
 * - Cache decrypted tokens in memory (encrypted at rest, decrypted in-process)
 * - `getCredential(credentialType, serverId?)` — Get the best credential for a given operation
 * - `reloadCredentials()` — Reload from DB (triggered by signal or NATS)
 * - `markRateLimited(credentialId, remaining, resetAt)` — Update rate limit info
 * - Key rotation: when a key is flagged rate-limited or exhausted, skip it in rotation
 */

import { db } from '../db.js';
import { pteroCredentials } from '../schema.js';
import { eq } from 'drizzle-orm';
import { decryptToken } from './encryptor.js';
import type { PteroCredentialType } from '@edenvanguard/shared';

export interface DecryptedCredential {
  credentialId: string;
  credentialType: PteroCredentialType;
  token: string; // decrypted
  serverScope: unknown;
  permissions: unknown;
  rateLimitRemaining: number | null;
  rateLimitResetAt: Date | null;
}

class CredentialLoader {
  private cache = new Map<string, DecryptedCredential>();
  private loaded = false;

  async loadAll(): Promise<void> {
    const rows = await db
      .select()
      .from(pteroCredentials)
      .where(eq(pteroCredentials.isActive, true));
    this.cache.clear();
    for (const row of rows) {
      const token = decryptToken(row.encryptedToken, row.tokenNonce, row.tokenTag);
      this.cache.set(row.credentialId, {
        credentialId: row.credentialId,
        credentialType: row.credentialType as PteroCredentialType,
        token,
        serverScope: row.serverScope,
        permissions: row.permissions,
        rateLimitRemaining: row.rateLimitRemaining,
        rateLimitResetAt: row.rateLimitResetAt,
      });
    }
    this.loaded = true;
  }

  /** Get the best credential for a given operation type and optional server scope */
  getCredential(credentialType: PteroCredentialType, serverId?: string): DecryptedCredential | null {
    const all = Array.from(this.cache.values());

    if (credentialType === 'client' && serverId) {
      // Prefer client key scoped to this server
      const scoped = all.find(
        (c) =>
          c.credentialType === 'client' &&
          Array.isArray(c.serverScope) &&
          c.serverScope.includes(serverId) &&
          !this.isRateLimited(c),
      );
      if (scoped) return scoped;
    }

    // Fall back to any active credential of the requested type
    const fallback = all.find(
      (c) => c.credentialType === credentialType && !this.isRateLimited(c),
    );
    return fallback ?? null;
  }

  /** Get all credentials of a given type (including rate-limited ones) */
  getCredentials(credentialType: PteroCredentialType): DecryptedCredential[] {
    return Array.from(this.cache.values()).filter((c) => c.credentialType === credentialType);
  }

  /** Check if a credential is currently rate-limited */
  private isRateLimited(cred: DecryptedCredential): boolean {
    if (cred.rateLimitRemaining === null) return false;
    if (cred.rateLimitRemaining > 20) return false; // above throttle threshold
    if (cred.rateLimitResetAt && new Date() < cred.rateLimitResetAt) return true;
    return false;
  }

  /** Mark a credential as having been used, with rate limit info from response headers */
  async markRateLimited(credentialId: string, remaining: number, resetAt: Date): Promise<void> {
    const cred = this.cache.get(credentialId);
    if (cred) {
      cred.rateLimitRemaining = remaining;
      cred.rateLimitResetAt = resetAt;
    }
    // Also update in DB for persistence across restarts
    await db
      .update(pteroCredentials)
      .set({ rateLimitRemaining: remaining, rateLimitResetAt: resetAt, updatedAt: new Date() })
      .where(eq(pteroCredentials.credentialId, credentialId));
  }

  /** Reload credentials from database */
  async reload(): Promise<void> {
    await this.loadAll();
  }

  get isLoaded(): boolean {
    return this.loaded;
  }
}

export const credentialLoader = new CredentialLoader();
