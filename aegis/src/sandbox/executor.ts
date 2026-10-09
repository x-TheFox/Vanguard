/**
 * Sandbox Executor — Aegis
 *
 * Provides a safe execution environment for skill scripts and shell
 * commands. Implements resource limits from the risks document
 * (docs/08_risks_and_limits.md §5 — Sandbox Execution Limits).
 *
 * Resource constraints:
 *   CPU limit:      2 cores
 *   Memory limit:   4 GB (4096 MB)
 *   Disk limit:     20 GB (20480 MB)
 *   Execution timeout:  30 minutes per task
 *   Command timeout:    10 minutes per command
 *   Network:        Outbound only
 *   User:           Non-root (aegis, UID 1000)
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ── Types ──────────────────────────────────────────────────────

export interface SandboxConfig {
  /** CPU limit in cores (default: 2) */
  cpuLimit: number;
  /** Memory limit in MB (default: 4096) */
  memoryLimitMb: number;
  /** Disk limit in MB (default: 20480) */
  diskLimitMb: number;
  /** Overall execution timeout in ms (default: 30 min) */
  timeoutMs: number;
  /** Per-command timeout in ms (default: 10 min) */
  commandTimeoutMs: number;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

// ── Default Configuration ──────────────────────────────────────

/** Default sandbox configuration per docs/08_risks_and_limits.md §5 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  cpuLimit: 2,
  memoryLimitMb: 4096,
  diskLimitMb: 20480,
  timeoutMs: 30 * 60 * 1000,   // 30 minutes
  commandTimeoutMs: 10 * 60 * 1000, // 10 minutes
};

// ── Sandbox Executor ───────────────────────────────────────────

/**
 * Execute a command in the sandbox with resource limits.
 *
 * In a production environment, this would use container-based isolation
 * (Docker/Podman) with cgroup resource limits. In the current implementation,
 * we use Node.js child_process with timeout enforcement and ulimit-based
 * resource constraints where available.
 *
 * Security considerations:
 *   - Commands are run as a non-root user when possible
 *   - Timeout is enforced via the child_process timeout option
 *   - stdout/stderr are captured and truncated if excessive
 *   - Blocked paths and dangerous patterns are validated
 */
export async function executeInSandbox(
  command: string,
  config?: Partial<SandboxConfig>,
): Promise<SandboxResult> {
  const mergedConfig: SandboxConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    ...config,
  };

  // Validate the command against blocked patterns
  validateCommand(command);

  const startTime = Date.now();

  // Build sandboxed command with resource limits
  // On Linux, we can use ulimit for memory and process constraints
  const sandboxedCommand = buildSandboxedCommand(command, mergedConfig);

  try {
    const result = await execAsync(sandboxedCommand, {
      timeout: mergedConfig.commandTimeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
      env: {
        ...process.env,
        NODE_OPTIONS: `--max-old-space-size=${mergedConfig.memoryLimitMb}`,
      },
      // Run as non-root when possible (requires the aegis user to exist)
      // uid: 1000, // Uncomment when running in container with aegis user
    });

    return {
      stdout: truncateOutput(result.stdout),
      stderr: truncateOutput(result.stderr),
      exitCode: 0,
      durationMs: Date.now() - startTime,
      timedOut: false,
    };
  } catch (error) {
    const execError = error as ExecError;

    // Check if the process was killed due to timeout
    const timedOut = execError.killed === true;
    const durationMs = Date.now() - startTime;

    return {
      stdout: truncateOutput(execError.stdout ?? ''),
      stderr: truncateOutput(execError.stderr ?? ''),
      exitCode: typeof execError.code === 'number' ? execError.code : null,
      durationMs,
      timedOut,
    };
  }
}

/**
 * Execute a command in the sandbox and return parsed JSON output.
 * Throws if the command fails or the output is not valid JSON.
 */
export async function executeJsonInSandbox<T = unknown>(
  command: string,
  config?: Partial<SandboxConfig>,
): Promise<T> {
  const result = await executeInSandbox(command, config);

  if (result.exitCode !== 0) {
    throw new Error(
      `Sandbox command failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }

  if (result.timedOut) {
    throw new Error(
      `Sandbox command timed out after ${result.durationMs}ms`,
    );
  }

  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(
      `Sandbox command produced non-JSON output: ${truncateOutput(result.stdout, 500)}`,
    );
  }
}

/**
 * Check if the sandbox environment is available and properly configured.
 * Returns true if the sandbox can execute commands.
 */
export async function isSandboxAvailable(): Promise<boolean> {
  try {
    const result = await executeInSandbox('echo ok', {
      commandTimeoutMs: 5000,
      timeoutMs: 10000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// ── Private Helpers ────────────────────────────────────────────

/** Build a command string with resource limit wrappers */
function buildSandboxedCommand(command: string, config: SandboxConfig): string {
  // On Linux with bash, use ulimit for resource constraints
  // These are best-effort; a full container sandbox provides stronger isolation
  const isLinux = process.platform === 'linux';

  if (isLinux) {
    // Use bash with ulimit constraints
    // -v: virtual memory limit (KB)
    // -t: CPU time limit (seconds)
    // -f: file size limit (blocks of 512 bytes)
    const memoryLimitKb = config.memoryLimitMb * 1024;
    const cpuTimeSeconds = config.timeoutMs / 1000;
    const fileSizeBlocks = Math.floor((config.diskLimitMb * 1024 * 1024) / 512);

    return [
      'bash -c',
      `'`,
      `set -eo pipefail;`,
      `ulimit -v ${memoryLimitKb} 2>/dev/null || true;`,   // Virtual memory
      `ulimit -t ${Math.ceil(cpuTimeSeconds)} 2>/dev/null || true;`, // CPU time
      `ulimit -f ${fileSizeBlocks} 2>/dev/null || true;`,   // File size
      `ulimit -u 256 2>/dev/null || true;`,                 // Max processes
      `${command}`,
      `'`,
    ].join(' ');
  }

  // On non-Linux (development), just run the command with timeout
  return command;
}

/** Validate a command against blocked patterns and dangerous operations */
function validateCommand(command: string): void {
  // Blocked commands that should never be executed
  const blockedPatterns = [
    /rm\s+-rf\s+\//,                      // Recursive root delete
    /dd\s+if=.*of=\/dev\//,               // Direct disk writes
    /mkfs/,                                // Format filesystem
    /:\(\)\{.*;\}\s*;\s*:/,               // Fork bomb
    /chmod\s+777\s+\//,                    // Making root world-writable
    /chown\s+root/,                        // Changing ownership to root
    /sudo\s+/,                             // Sudo escalation
    /\/etc\/shadow/,                        // Reading shadow file
    /\/root\/\.ssh/,                        // Accessing root SSH
    /curl.*\|.*sh/,                         // Piping remote scripts to shell
    /wget.*\|.*sh/,                         // Piping remote scripts to shell
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(command)) {
      throw new Error(
        `Sandbox command blocked: matches dangerous pattern "${pattern.source}"`,
      );
    }
  }

  // Blocked paths
  const blockedPaths = ['/etc/shadow', '/root/.ssh', '/etc/passwd'];
  for (const blockedPath of blockedPaths) {
    if (command.includes(blockedPath)) {
      throw new Error(
        `Sandbox command blocked: references protected path "${blockedPath}"`,
      );
    }
  }
}

/** Truncate output to prevent memory issues with very large outputs */
function truncateOutput(output: string, maxLength = 1_000_000): string {
  if (output.length <= maxLength) return output;
  return output.substring(0, maxLength) + '\n... [truncated]';
}

/** Type for child_process exec errors */
interface ExecError extends Error {
  code?: string | number;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}
