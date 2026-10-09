/**
 * Path Sanitizer — Prevents directory traversal and access to protected paths
 *
 * All file paths used in MCP tools are sanitized here before being
 * sent to the Pterodactyl API. This prevents directory traversal attacks
 * and blocks access to protected directories.
 */

import { SAFETY } from '@edenvanguard/shared';

const PROTECTED_PATHS = SAFETY.PROTECTED_PATHS;

/** Sanitize a file path to prevent directory traversal attacks */
export function sanitizePath(path: string): string {
  // Reject paths containing directory traversal
  if (path.includes('..')) {
    throw new Error(`Path traversal detected: "${path}" contains ".."`);
  }

  // Normalize the path
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');

  return normalized;
}

/** Check if a path is in a protected directory */
export function isProtectedPath(path: string): boolean {
  const normalized = sanitizePath(path);
  return PROTECTED_PATHS.some(
    (protected_) =>
      normalized.startsWith(protected_) || normalized.includes(protected_),
  );
}
