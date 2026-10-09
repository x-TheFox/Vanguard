/**
 * Server Management Tools — MCP tool implementations for server listing, details, and power control
 *
 * Tools:
 * - list_servers (Application API, auto-paginate)
 * - get_server (Client API)
 * - get_server_resources (Client API)
 * - start_server (Client API, safe)
 * - stop_server (Client API, gated)
 * - restart_server (Client API, safe)
 * - kill_server (Client API, gated)
 */

import { pteroClient } from '../httpClient.js';
import { checkPermissionGate } from '../safety/permissionGates.js';
import { autoPaginate } from '../pagination/autoPaginator.js';
import { redactSecrets } from '@edenvanguard/shared';

// ── Helper ────────────────────────────────────────────────────

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

// ── list_servers ──────────────────────────────────────────────

export interface ListServersParams {
  filter_name?: string;
}

export async function listServers(params: ListServersParams) {
  try {
    const filterName = params.filter_name;

    const results = await autoPaginate((page) =>
      pteroClient.get(
        `/api/application/servers${filterName ? `?filter[name]=${encodeURIComponent(filterName)}` : ''}&page=${page}`,
        'list_servers',
      ).then((res) => {
        const response = res.data as {
          data: unknown[];
          meta: { pagination: { total: number; count: number; per_page: number; current_page: number; total_pages: number } };
        };
        return response;
      }),
    );

    return toolResult(results);
  } catch (error: unknown) {
    return handleError(error, 'list_servers');
  }
}

// ── get_server ────────────────────────────────────────────────

export interface GetServerParams {
  server_id: string;
}

export async function getServer(params: GetServerParams) {
  try {
    const response = await pteroClient.get(
      `/api/client/servers/${params.server_id}`,
      'get_server',
      params.server_id,
    );
    return toolResult(response.data);
  } catch (error: unknown) {
    return handleError(error, 'get_server');
  }
}

// ── get_server_resources ──────────────────────────────────────

export async function getServerResources(params: GetServerParams) {
  try {
    const response = await pteroClient.get(
      `/api/client/servers/${params.server_id}/resources`,
      'get_server_resources',
      params.server_id,
    );
    return toolResult(response.data);
  } catch (error: unknown) {
    return handleError(error, 'get_server_resources');
  }
}

// ── Power control helpers ─────────────────────────────────────

interface PowerParams {
  server_id: string;
  confirm?: boolean;
  [key: string]: unknown;
}

async function sendPowerSignal(
  toolName: string,
  serverId: string,
  signal: 'start' | 'stop' | 'restart' | 'kill',
  params: PowerParams,
) {
  // Check permission gate for gated operations
  const gate = checkPermissionGate(toolName, params);
  if (!gate.allowed) {
    return errorResult(gate.reason ?? `Permission denied for ${toolName}`);
  }

  await pteroClient.post(
    `/api/client/servers/${serverId}/power`,
    { signal },
    toolName,
    serverId,
  );

  return toolResult({ success: true, signal, server_id: serverId });
}

// ── start_server ──────────────────────────────────────────────

export async function startServer(params: PowerParams) {
  try {
    return await sendPowerSignal('start_server', params.server_id, 'start', params);
  } catch (error: unknown) {
    return handleError(error, 'start_server');
  }
}

// ── stop_server ───────────────────────────────────────────────

export async function stopServer(params: PowerParams) {
  try {
    return await sendPowerSignal('stop_server', params.server_id, 'stop', params);
  } catch (error: unknown) {
    return handleError(error, 'stop_server');
  }
}

// ── restart_server ────────────────────────────────────────────

export async function restartServer(params: PowerParams) {
  try {
    return await sendPowerSignal('restart_server', params.server_id, 'restart', params);
  } catch (error: unknown) {
    return handleError(error, 'restart_server');
  }
}

// ── kill_server ───────────────────────────────────────────────

export async function killServer(params: PowerParams) {
  try {
    return await sendPowerSignal('kill_server', params.server_id, 'kill', params);
  } catch (error: unknown) {
    return handleError(error, 'kill_server');
  }
}
