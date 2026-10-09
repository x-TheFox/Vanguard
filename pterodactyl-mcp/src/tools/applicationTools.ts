/**
 * Application Tools — MCP tool implementations for Application API operations
 *
 * Tools:
 * - get_build_config (Application API)
 * - update_build_config (Application API, gated)
 * - update_startup (Application API, gated)
 */

import { pteroClient } from '../httpClient.js';
import { checkPermissionGate } from '../safety/permissionGates.js';
import { redactSecrets } from '@edenvanguard/shared';

// ── Helpers ───────────────────────────────────────────────────

function toolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

function handleError(error: unknown, toolName: string) {
  const msg = error instanceof Error ? error.message : String(error);
  return errorResult(`[${toolName}] ${redactSecrets(msg)}`);
}

// ── get_build_config ──────────────────────────────────────────

export interface GetBuildConfigParams {
  server_id: string;
}

export async function getBuildConfig(params: GetBuildConfigParams) {
  try {
    const response = await pteroClient.get(
      `/api/application/servers/${params.server_id}`,
      'get_build_config',
    );

    // Extract the build configuration from the server details
    const serverData = response.data as {
      attributes: {
        limits: Record<string, unknown>;
        feature_limits: Record<string, unknown>;
        allocation: number;
        [key: string]: unknown;
      };
    };

    const { limits, feature_limits, allocation } = serverData.attributes;

    return toolResult({
      server_id: params.server_id,
      limits,
      feature_limits,
      allocation,
    });
  } catch (error: unknown) {
    return handleError(error, 'get_build_config');
  }
}

// ── update_build_config ───────────────────────────────────────

export interface UpdateBuildConfigParams {
  server_id: string;
  allocation?: number;
  cpu?: number;
  disk?: number;
  io?: number;
  confirm?: boolean;
  [key: string]: unknown;
}

export async function updateBuildConfig(params: UpdateBuildConfigParams) {
  try {
    // Check permission gate
    const gate = checkPermissionGate('update_build_config', params as Record<string, unknown>);
    if (!gate.allowed) {
      return errorResult(gate.reason ?? 'Permission denied for update_build_config');
    }

    // Build the update payload — only include fields that are provided
    const body: Record<string, unknown> = {};

    const limits: Record<string, unknown> = {};
    if (params.allocation !== undefined) limits.memory = params.allocation;
    if (params.cpu !== undefined) limits.cpu = params.cpu;
    if (params.disk !== undefined) limits.disk = params.disk;
    if (params.io !== undefined) limits.io = params.io;

    if (Object.keys(limits).length > 0) {
      body.allocation = params.allocation;
      body.limits = limits;
    }

    const response = await pteroClient.patch(
      `/api/application/servers/${params.server_id}/build`,
      body,
      'update_build_config',
    );

    return toolResult({
      success: true,
      server_id: params.server_id,
      updated: response.data,
    });
  } catch (error: unknown) {
    return handleError(error, 'update_build_config');
  }
}

// ── update_startup ────────────────────────────────────────────

export interface UpdateStartupParams {
  server_id: string;
  startup?: string;
  environment?: Record<string, string>;
  confirm?: boolean;
  [key: string]: unknown;
}

export async function updateStartup(params: UpdateStartupParams) {
  try {
    // Check permission gate
    const gate = checkPermissionGate('update_startup', params as Record<string, unknown>);
    if (!gate.allowed) {
      return errorResult(gate.reason ?? 'Permission denied for update_startup');
    }

    const body: Record<string, unknown> = {};
    if (params.startup !== undefined) body.startup = params.startup;
    if (params.environment !== undefined) body.environment = params.environment;

    const response = await pteroClient.patch(
      `/api/application/servers/${params.server_id}/startup`,
      body,
      'update_startup',
    );

    return toolResult({
      success: true,
      server_id: params.server_id,
      updated: response.data,
    });
  } catch (error: unknown) {
    return handleError(error, 'update_startup');
  }
}
