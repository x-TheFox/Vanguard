/**
 * Permission Gates — Enforces confirmation requirements for gated tools
 *
 * Gated operations (stop, kill, delete, restore, etc.) require explicit
 * confirmation before execution. This module checks that the required
 * confirmation parameters are present before allowing the operation.
 */

import { isConfirmationRequired } from '../auth/keyScopeResolver.js';

/** Check if a tool invocation has the required confirmation for gated operations */
export function checkPermissionGate(
  toolName: string,
  params: Record<string, unknown>,
): { allowed: boolean; reason?: string } {
  if (!isConfirmationRequired(toolName)) {
    return { allowed: true };
  }

  // Special double-confirm for backup restore with truncate
  // When truncate is requested, BOTH confirm AND confirm_truncate must be true
  if (
    toolName === 'restore_backup' &&
    params.confirm_truncate === true &&
    params.confirm !== true
  ) {
    return {
      allowed: false,
      reason:
        'Restoring a backup with truncate requires both confirm: true AND confirm_truncate: true',
    };
  }

  // Gated tools require confirm: true
  if (params.confirm !== true) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" requires explicit confirmation. Pass confirm: true to proceed.`,
    };
  }

  return { allowed: true };
}
