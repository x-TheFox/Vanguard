/**
 * Pterodactyl HTTP Client — Core HTTP client with rate limiting and credential rotation
 *
 * This is the ONLY component that makes HTTP calls to the Pterodactyl panel.
 * All MCP tools use this client to make API requests. It handles:
 * - Automatic credential selection based on tool requirements
 * - Per-key rate limit tracking and throttling
 * - Error handling with secret redaction
 * - Response header inspection for rate limit updates
 */

import { credentialLoader } from './auth/credentialLoader.js';
import { rateLimitTracker } from './rateLimiter/tracker.js';
import { resolveToolScope } from './auth/keyScopeResolver.js';
import { redactSecrets } from '@edenvanguard/shared';

interface PteroRequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  params?: Record<string, string>;
  toolName: string;
  serverId?: string;
}

export interface PteroResponse<T = unknown> {
  data: T;
  status: number;
  headers: Headers;
}

export class PteroHttpClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = (process.env.PTERO_PANEL_URL ?? '').replace(/\/$/, '');
    if (!this.baseUrl) {
      throw new Error('PTERO_PANEL_URL environment variable is not set');
    }
  }

  async request<T = unknown>(options: PteroRequestOptions): Promise<PteroResponse<T>> {
    const { method, path, body, params, toolName, serverId } = options;

    // Resolve which credential type to use
    const scope = resolveToolScope(toolName);
    if (!scope) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    // Get an available credential ID (not rate-limited)
    const credentialId = rateLimitTracker.getNextAvailableCredential(
      scope.credentialType,
      serverId,
    );
    if (!credentialId) {
      const creds = credentialLoader.getCredentials(scope.credentialType);
      if (creds.length === 0) {
        throw new Error(
          `No ${scope.credentialType} credentials configured for tool: ${toolName}`,
        );
      }
      throw new Error(
        `All ${scope.credentialType} credentials are rate-limited. Retry after reset.`,
      );
    }

    const credential = credentialLoader.getCredential(scope.credentialType, serverId);
    if (!credential) {
      throw new Error(`Failed to load credential for tool: ${toolName}`);
    }

    // Build URL
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    // Make request
    const response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${credential.token}`,
        Accept: 'application/vnd.pterodactyl.v1+json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // Update rate limit tracking from response headers
    const rateLimitLimit = response.headers.get('X-RateLimit-Limit');
    const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
    const rateLimitReset = response.headers.get('X-RateLimit-Reset');

    if (rateLimitLimit && rateLimitRemaining && rateLimitReset) {
      rateLimitTracker.updateFromHeaders(
        credentialId,
        parseInt(rateLimitLimit, 10),
        parseInt(rateLimitRemaining, 10),
        parseInt(rateLimitReset, 10),
      );
    }

    // Handle errors
    if (!response.ok) {
      if (response.status === 429) {
        throw new Error(
          `Pterodactyl rate limit exceeded. Retry after ${rateLimitReset ?? 'unknown'}`,
        );
      }

      const errorBody = await response.text();
      throw new Error(
        `Pterodactyl API error ${response.status}: ${redactSecrets(errorBody)}`,
      );
    }

    const data = (await response.json()) as T;
    return { data, status: response.status, headers: response.headers };
  }

  /** Convenience method for GET requests */
  async get<T = unknown>(
    path: string,
    toolName: string,
    serverId?: string,
  ): Promise<PteroResponse<T>> {
    return this.request<T>({ method: 'GET', path, toolName, serverId });
  }

  /** Convenience method for POST requests */
  async post<T = unknown>(
    path: string,
    body: unknown,
    toolName: string,
    serverId?: string,
  ): Promise<PteroResponse<T>> {
    return this.request<T>({ method: 'POST', path, body, toolName, serverId });
  }

  /** Convenience method for PATCH requests */
  async patch<T = unknown>(
    path: string,
    body: unknown,
    toolName: string,
    serverId?: string,
  ): Promise<PteroResponse<T>> {
    return this.request<T>({ method: 'PATCH', path, body, toolName, serverId });
  }

  /** Convenience method for DELETE requests */
  async delete<T = unknown>(
    path: string,
    toolName: string,
    serverId?: string,
  ): Promise<PteroResponse<T>> {
    return this.request<T>({ method: 'DELETE', path, toolName, serverId });
  }
}

export const pteroClient = new PteroHttpClient();
