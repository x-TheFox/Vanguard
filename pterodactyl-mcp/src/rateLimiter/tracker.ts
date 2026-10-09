/**
 * Rate Limit Tracker — Per-key rate limit tracking
 *
 * Tracks Pterodactyl API rate limit state per credential, updating
 * from response headers and providing throttle checks to the HTTP client.
 * Persists state to the database for cross-restart consistency.
 */

import { credentialLoader } from '../auth/credentialLoader.js';
import type { PteroCredentialType } from '@edenvanguard/shared';

interface RateLimitState {
  remaining: number;
  limit: number;
  resetAt: Date;
  lastRequestAt: Date;
}

class RateLimitTracker {
  private states = new Map<string, RateLimitState>();
  private readonly THROTTLE_THRESHOLD = 20;

  /** Update rate limit state from response headers */
  updateFromHeaders(
    credentialId: string,
    limit: number,
    remaining: number,
    resetTimestamp: number,
  ): void {
    const resetAt = new Date(resetTimestamp * 1000);
    this.states.set(credentialId, {
      remaining,
      limit,
      resetAt,
      lastRequestAt: new Date(),
    });

    // Also persist to database for cross-restart consistency
    credentialLoader.markRateLimited(credentialId, remaining, resetAt).catch((err: unknown) => {
      console.error('Failed to persist rate limit state:', err);
    });
  }

  /** Check if we should throttle requests for this credential */
  shouldThrottle(credentialId: string): boolean {
    const state = this.states.get(credentialId);
    if (!state) return false;

    if (state.remaining <= this.THROTTLE_THRESHOLD) {
      // Check if the reset time has passed
      if (new Date() >= state.resetAt) {
        this.states.delete(credentialId);
        return false;
      }
      return true;
    }

    return false;
  }

  /** Get the next available credential ID that is not rate-limited */
  getNextAvailableCredential(
    credentialType: PteroCredentialType,
    serverId?: string,
  ): string | null {
    const creds = credentialLoader.getCredentials(credentialType);

    for (const cred of creds) {
      if (!this.shouldThrottle(cred.credentialId)) {
        // If serverId specified, check scope
        if (serverId && cred.credentialType === 'client') {
          const scope = cred.serverScope as string[] | undefined;
          if (scope && !scope.includes(serverId)) continue;
        }
        return cred.credentialId;
      }
    }

    return null;
  }

  /** Get time until rate limit resets for a credential (in ms) */
  getTimeUntilReset(credentialId: string): number {
    const state = this.states.get(credentialId);
    if (!state) return 0;
    return Math.max(0, state.resetAt.getTime() - Date.now());
  }
}

export const rateLimitTracker = new RateLimitTracker();
