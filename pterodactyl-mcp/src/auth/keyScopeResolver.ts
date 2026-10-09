/**
 * Key Scope Resolver — Maps tool names to credential requirements
 *
 * Determines which credential type (Application or Client API key) a given
 * MCP tool requires, and whether the tool has a permission gate (safe/gated).
 */

import type { PermissionGate } from '@edenvanguard/shared';

/** Map of tool names to their credential requirements */
const TOOL_CREDENTIAL_MAP: Record<
  string,
  {
    credentialType: 'application' | 'client';
    permissionGate: PermissionGate;
    requiredPermissions?: string[];
  }
> = {
  // Server management — Application API preferred for listing all servers
  list_servers: { credentialType: 'application', permissionGate: 'safe' },
  get_server: { credentialType: 'client', permissionGate: 'safe' },
  get_server_resources: { credentialType: 'client', permissionGate: 'safe' },
  send_command: { credentialType: 'client', permissionGate: 'safe' },
  start_server: { credentialType: 'client', permissionGate: 'safe' },
  stop_server: { credentialType: 'client', permissionGate: 'gated' },
  restart_server: { credentialType: 'client', permissionGate: 'safe' },
  kill_server: { credentialType: 'client', permissionGate: 'gated' },

  // File management — Client API
  list_files: { credentialType: 'client', permissionGate: 'safe' },
  read_file: { credentialType: 'client', permissionGate: 'safe' },
  write_file: { credentialType: 'client', permissionGate: 'safe' },
  upload_file: { credentialType: 'client', permissionGate: 'safe' },
  delete_files: { credentialType: 'client', permissionGate: 'gated' },
  rename_files: { credentialType: 'client', permissionGate: 'safe' },
  create_folder: { credentialType: 'client', permissionGate: 'safe' },

  // Backup management — Client API
  list_backups: { credentialType: 'client', permissionGate: 'safe' },
  create_backup: { credentialType: 'client', permissionGate: 'safe' },
  get_backup_status: { credentialType: 'client', permissionGate: 'safe' },
  restore_backup: { credentialType: 'client', permissionGate: 'gated' },
  delete_backup: { credentialType: 'client', permissionGate: 'gated' },

  // Player count — Client API (WebSocket)
  get_player_count: { credentialType: 'client', permissionGate: 'safe' },

  // Schedule management — Client API
  list_schedules: { credentialType: 'client', permissionGate: 'safe' },
  create_schedule: { credentialType: 'client', permissionGate: 'safe' },

  // Application-level tools
  get_build_config: { credentialType: 'application', permissionGate: 'safe' },
  update_build_config: { credentialType: 'application', permissionGate: 'gated' },
  update_startup: { credentialType: 'application', permissionGate: 'gated' },
};

/** Resolve the credential type and permission gate for a given tool */
export function resolveToolScope(toolName: string): {
  credentialType: 'application' | 'client';
  permissionGate: PermissionGate;
  requiredPermissions?: string[];
} | null {
  return TOOL_CREDENTIAL_MAP[toolName] ?? null;
}

/** Check if a gated tool has the required confirmation parameter */
export function isConfirmationRequired(toolName: string): boolean {
  const scope = TOOL_CREDENTIAL_MAP[toolName];
  return scope?.permissionGate === 'gated';
}
