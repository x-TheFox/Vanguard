/**
 * Backup Management Tools — MCP tool implementations for backup operations
 *
 * Tools:
 * - list_backups (Client API, auto-paginate)
 * - create_backup (Client API, async polling)
 * - get_backup_status (Client API)
 * - restore_backup (Client API, gated, double-confirm for truncate)
 * - delete_backup (Client API, gated)
 *
 * Backup creation is ASYNC — POST returns immediately with status "processing".
 * Must poll get_backup_status until completed or timeout.
 */

import { pteroClient } from '../httpClient.js';
import { checkPermissionGate } from '../safety/permissionGates.js';
import { autoPaginate } from '../pagination/autoPaginator.js';
import { redactSecrets, RATE_LIMITS } from '@edenvanguard/shared';

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

// ── list_backups ──────────────────────────────────────────────

export interface ListBackupsParams {
  server_id: string;
}

export async function listBackups(params: ListBackupsParams) {
  try {
    const results = await autoPaginate((page) =>
      pteroClient.get(
        `/api/client/servers/${params.server_id}/backups?page=${page}`,
        'list_backups',
        params.server_id,
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
    return handleError(error, 'list_backups');
  }
}

// ── create_backup ─────────────────────────────────────────────

export interface CreateBackupParams {
  server_id: string;
  name: string;
  ignored?: string[];
  timeout_seconds?: number;
}

export async function createBackup(params: CreateBackupParams) {
  try {
    const body: Record<string, unknown> = { name: params.name };
    if (params.ignored && params.ignored.length > 0) {
      body.ignored = params.ignored;
    }

    // Initiate backup creation
    const createResponse = await pteroClient.post(
      `/api/client/servers/${params.server_id}/backups`,
      body,
      'create_backup',
      params.server_id,
    );

    const backupData = createResponse.data as {
      attributes: {
        uuid: string;
        name: string;
        status: string;
        [key: string]: unknown;
      };
    };

    const backupUuid = backupData.attributes.uuid;

    // If already completed (unlikely but possible), return immediately
    if (backupData.attributes.status === 'completed') {
      return toolResult(backupData.attributes);
    }

    // Poll for completion
    const timeoutMs = (params.timeout_seconds ?? 600) * 1000;
    const pollInterval = RATE_LIMITS.BACKUP_POLL_INTERVAL_MS;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      const statusResult = await getBackupStatusRaw(params.server_id, backupUuid);
      if (statusResult.status === 'completed') {
        return toolResult(statusResult.data);
      }

      if (statusResult.status === 'failed') {
        return errorResult(`[create_backup] Backup creation failed for UUID ${backupUuid}`);
      }

      // status is still "processing" — continue polling
    }

    // Timeout reached
    return errorResult(
      `[create_backup] Backup creation timed out after ${params.timeout_seconds ?? 600}s. Backup UUID: ${backupUuid}. Check get_backup_status for current state.`,
    );
  } catch (error: unknown) {
    return handleError(error, 'create_backup');
  }
}

// ── get_backup_status ─────────────────────────────────────────

export interface GetBackupStatusParams {
  server_id: string;
  backup_uuid: string;
}

interface BackupStatusResult {
  status: string;
  data: unknown;
}

/** Internal raw status fetcher (no MCP result wrapping) */
async function getBackupStatusRaw(serverId: string, backupUuid: string): Promise<BackupStatusResult> {
  const response = await pteroClient.get(
    `/api/client/servers/${serverId}/backups/${backupUuid}`,
    'get_backup_status',
    serverId,
  );

  const data = response.data as {
    attributes: {
      uuid: string;
      status: string;
      [key: string]: unknown;
    };
  };

  return {
    status: data.attributes.status,
    data: data.attributes,
  };
}

export async function getBackupStatus(params: GetBackupStatusParams) {
  try {
    const result = await getBackupStatusRaw(params.server_id, params.backup_uuid);
    return toolResult(result.data);
  } catch (error: unknown) {
    return handleError(error, 'get_backup_status');
  }
}

// ── restore_backup ────────────────────────────────────────────

export interface RestoreBackupParams {
  server_id: string;
  backup_uuid: string;
  truncate?: boolean;
  confirm?: boolean;
  confirm_truncate?: boolean;
  [key: string]: unknown;
}

export async function restoreBackup(params: RestoreBackupParams) {
  try {
    // Check permission gate — gated tool requires confirm:true
    const gate = checkPermissionGate('restore_backup', params as Record<string, unknown>);
    if (!gate.allowed) {
      return errorResult(gate.reason ?? 'Permission denied for restore_backup');
    }

    // Double-confirm for truncate
    if (params.truncate === true && params.confirm_truncate !== true) {
      return errorResult(
        'Restoring a backup with truncate requires BOTH confirm: true AND confirm_truncate: true',
      );
    }

    const body: Record<string, unknown> = {};
    if (params.truncate === true) {
      body.truncate = true;
    }

    await pteroClient.post(
      `/api/client/servers/${params.server_id}/backups/${params.backup_uuid}/restore`,
      body,
      'restore_backup',
      params.server_id,
    );

    return toolResult({
      success: true,
      server_id: params.server_id,
      backup_uuid: params.backup_uuid,
      truncated: params.truncate === true,
    });
  } catch (error: unknown) {
    return handleError(error, 'restore_backup');
  }
}

// ── delete_backup ─────────────────────────────────────────────

export interface DeleteBackupParams {
  server_id: string;
  backup_uuid: string;
  confirm?: boolean;
  [key: string]: unknown;
}

export async function deleteBackup(params: DeleteBackupParams) {
  try {
    // Check permission gate
    const gate = checkPermissionGate('delete_backup', params as Record<string, unknown>);
    if (!gate.allowed) {
      return errorResult(gate.reason ?? 'Permission denied for delete_backup');
    }

    await pteroClient.delete(
      `/api/client/servers/${params.server_id}/backups/${params.backup_uuid}`,
      'delete_backup',
      params.server_id,
    );

    return toolResult({
      success: true,
      server_id: params.server_id,
      backup_uuid: params.backup_uuid,
    });
  } catch (error: unknown) {
    return handleError(error, 'delete_backup');
  }
}
