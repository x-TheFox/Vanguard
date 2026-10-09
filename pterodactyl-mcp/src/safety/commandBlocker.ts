/**
 * Command Blocker — Console command safety enforcement
 *
 * Blocks dangerous console commands that should never be executed
 * autonomously (e.g., `op`, `deop`). These are manual admin actions.
 */

import { SAFETY } from '@edenvanguard/shared';

const BLOCKED_PATTERNS = SAFETY.BLOCKED_COMMANDS;

/** Check if a console command is blocked */
export function isCommandBlocked(command: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(command));
}

/** Validate a console command and return the reason if blocked */
export function validateCommand(command: string): { allowed: boolean; reason?: string } {
  if (isCommandBlocked(command)) {
    return { allowed: false, reason: `Command "${command}" is blocked for safety reasons` };
  }
  return { allowed: true };
}
