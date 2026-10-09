/**
 * LLM Inference Client — Aegis
 *
 * Handles LLM API calls with 429 resilience, round-robin key rotation,
 * and automatic retry. All API keys are stored encrypted in the database
 * and rotated on rate-limit events.
 */

import { createDecipheriv } from 'node:crypto';
import { db } from '../db/client.js';
import { apiKeys, rateLimitEvents } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import type { InferenceRequest, InferenceResponse, LlmProvider } from '@edenvanguard/shared';

// ── Types ──────────────────────────────────────────────────────

interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface GroqResponse {
  choices: Array<{
    message: { content: string };
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }>;
  model: string;
}

interface KeyInfo {
  keyId: string;
  token: string;
}

// ── Inference Client ───────────────────────────────────────────

class InferenceClient {
  private currentKeyIndex = new Map<LlmProvider, number>();
  private static readonly MAX_RETRY_ATTEMPTS = 3;

  /**
   * Resolve the usable bearer token for an api_keys row.
   *
   * Tokens are stored AES-256-GCM-encrypted (hex ciphertext / nonce / auth tag),
   * mirroring the scheme in pterodactyl-mcp/src/auth/encryptor.ts for
   * ptero_credentials. Resolution is tolerant by design:
   *  - ENCRYPTION_KEY unset  → dev mode: pass the stored value through (warned).
   *  - Decryption failure    → wrong key or plaintext bootstrap row: pass the
   *    stored value through (warned) so operators are not locked out.
   * Production deployments MUST set ENCRYPTION_KEY and store encrypted tokens.
   */
  private resolveApiToken(stored: { keyId: string; encryptedToken: string; tokenNonce: string; tokenTag: string }): string {
    const keyHex = process.env.ENCRYPTION_KEY;
    if (!keyHex) {
      console.warn(
        `[inference] ENCRYPTION_KEY not set — using stored token for key ${stored.keyId} as-is (dev mode)`,
      );
      return stored.encryptedToken;
    }

    try {
      const key = Buffer.from(keyHex, 'hex');
      if (key.length !== 32) {
        throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(stored.tokenNonce, 'hex'),
        { authTagLength: 16 },
      );
      decipher.setAuthTag(Buffer.from(stored.tokenTag, 'hex'));
      let plaintext = decipher.update(stored.encryptedToken, 'hex', 'utf8');
      plaintext += decipher.final('utf8');
      return plaintext;
    } catch (err) {
      console.warn(
        `[inference] token decryption failed for key ${stored.keyId} (${(err as Error).message}) — falling back to stored value (plaintext bootstrap token?)`,
      );
      return stored.encryptedToken;
    }
  }

  /** Get the next valid API key using round-robin */
  private async getNextValidKey(provider: LlmProvider): Promise<KeyInfo | null> {
    const keys = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.provider, provider), eq(apiKeys.isActive, true)))
      .limit(10);

    if (keys.length === 0) return null;

    // Round-robin rotation
    const currentIndex = this.currentKeyIndex.get(provider) ?? 0;
    const nextIndex = (currentIndex + 1) % keys.length;
    this.currentKeyIndex.set(provider, nextIndex);

    const key = keys[nextIndex];
    if (!key) return null;

    // Decrypt the stored token (tolerant — see resolveApiToken docstring)
    return { keyId: key.keyId, token: this.resolveApiToken(key) };
  }

  /** Send a chat completion request to the LLM provider */
  async chat(request: InferenceRequest): Promise<InferenceResponse> {
    return this.chatWithRetry(request, 0);
  }

  /** Internal: chat with retry logic for rate limiting */
  private async chatWithRetry(request: InferenceRequest, attempt: number): Promise<InferenceResponse> {
    if (attempt >= InferenceClient.MAX_RETRY_ATTEMPTS) {
      throw new Error('Max retry attempts exceeded for LLM inference request');
    }

    const provider: LlmProvider = 'groq'; // Default provider

    const keyInfo = await this.getNextValidKey(provider);
    if (!keyInfo) {
      throw new Error(`No active API keys available for provider: ${provider}`);
    }

    const messages: GroqMessage[] = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${keyInfo.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: request.temperature ?? 0.3,
        max_tokens: request.maxTokens ?? 4096,
      }),
    });

    if (response.status === 429) {
      // Rate limited — mark key as rate-limited, record the event for
      // analytics/rotation tuning (rate_limit_events table), and retry
      // with the next key in the rotation.
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;

      await db
        .update(apiKeys)
        .set({
          isRateLimited: true,
          rateLimitResetAt: new Date(Date.now() + (retryAfterMs ?? 60_000)),
          updatedAt: new Date(),
        })
        .where(eq(apiKeys.keyId, keyInfo.keyId));

      await db.insert(rateLimitEvents).values({
        keyId: keyInfo.keyId,
        provider,
        httpStatus: 429,
        retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null,
      });

      // Retry with next key
      return this.chatWithRetry(request, attempt + 1);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`LLM API error ${response.status}: ${errorBody.substring(0, 500)}`);
    }

    const data = (await response.json()) as GroqResponse;
    const choice = data.choices[0];
    if (!choice) {
      throw new Error('LLM API returned no choices');
    }

    // Update key usage stats. The prior read must happen before the update and
    // be summed explicitly — `x ?? 0 + n` would bind as `x ?? (0 + n)` and
    // silently never increment tokensUsed for rows that already have a value.
    const priorUsage = await db
      .select({ tokensUsed: apiKeys.tokensUsed })
      .from(apiKeys)
      .where(eq(apiKeys.keyId, keyInfo.keyId))
      .limit(1);

    await db
      .update(apiKeys)
      .set({
        lastUsedAt: new Date(),
        tokensUsed: (priorUsage[0]?.tokensUsed ?? 0) + choice.usage.total_tokens,
        updatedAt: new Date(),
      })
      .where(eq(apiKeys.keyId, keyInfo.keyId));

    return {
      content: choice.message.content,
      provider,
      model: data.model,
      tokensUsed: choice.usage.total_tokens,
      correlationId: request.correlationId,
    };
  }
}

/** Singleton inference client instance */
export const inferenceClient = new InferenceClient();
