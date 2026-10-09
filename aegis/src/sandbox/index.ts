/**
 * Sandbox Module — Aegis
 *
 * Provides safe execution environments for skill scripts and
 * shell commands with resource limits and security constraints.
 */

export {
  executeInSandbox,
  executeJsonInSandbox,
  isSandboxAvailable,
  DEFAULT_SANDBOX_CONFIG,
  type SandboxConfig,
  type SandboxResult,
} from './executor.js';
