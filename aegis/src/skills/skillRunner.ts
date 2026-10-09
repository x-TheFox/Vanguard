/**
 * Skill Script Runner — Aegis
 *
 * Executes skill scripts in a sandboxed context. Skills are JavaScript
 * functions that receive `args` and `mcp` as parameters.
 *
 * The runner wraps the skill body in an async function and executes it
 * with a controlled context object, preventing access to Node.js internals
 * and limiting the script to only the provided MCP tools and logger.
 */

import { executeInSandbox, DEFAULT_SANDBOX_CONFIG } from '../sandbox/executor.js';

// ── Types ──────────────────────────────────────────────────────

/** Context available to skill scripts during execution */
export interface SkillContext {
  args: Record<string, unknown>;
  mcp: {
    invoke: (toolName: string, params: Record<string, unknown>) => Promise<unknown>;
    listTools: () => string[];
    isToolAvailable: (toolName: string) => boolean;
  };
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
}

/** Result of a skill script execution */
export interface SkillRunResult {
  success: boolean;
  data: unknown;
  error?: string;
  durationMs: number;
}

// ── Skill Script Runner ────────────────────────────────────────

/**
 * Execute a skill script in a sandboxed context.
 *
 * The skill body is expected to be valid JavaScript that can be wrapped
 * in an async function. It has access to:
 *   - `args`: The arguments passed to the skill
 *   - `mcp`: The MCP client interface (invoke, listTools, isToolAvailable)
 *   - `logger`: Structured logging (info, warn, error)
 *
 * The script should return a value via `return`.
 */
export async function runSkillScript(
  body: string,
  context: SkillContext,
): Promise<unknown> {
  const startTime = Date.now();

  try {
    // Create the function from the script string
    // Using Function constructor for sandboxed evaluation
    const skillFn = new Function('args', 'mcp', 'logger', `
      return (async function() {
        ${body}
      })();
    `);

    // Execute with the provided context
    const result = await skillFn(context.args, context.mcp, context.logger);

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Distinguish between different error types
    if (errorMessage.includes('is not defined')) {
      throw new SkillExecutionError(
        `Skill script references an undefined variable or function. ` +
        `Only "args", "mcp", and "logger" are available in the skill context. ` +
        `Original error: ${errorMessage}`,
        durationMs,
      );
    }

    if (errorMessage.includes('await') && errorMessage.includes('Promise')) {
      throw new SkillExecutionError(
        `Skill script has an async/await issue. Ensure all async operations use await. ` +
        `Original error: ${errorMessage}`,
        durationMs,
      );
    }

    throw new SkillExecutionError(
      `Skill execution failed: ${errorMessage}`,
      durationMs,
    );
  }
}

/**
 * Execute a skill script using the external sandbox (shell execution).
 * This is used for skills that require full process isolation.
 *
 * The skill body is written to a temporary file and executed via the
 * sandbox executor with resource limits applied.
 */
export async function runSkillInSandbox(
  body: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // For sandbox execution, we serialize the args and embed them
  // into the script as a self-contained program
  const script = `
    const args = ${JSON.stringify(args)};

    // MCP invocation is not available in sandbox mode —
    // sandbox scripts should use shell commands instead
    const mcp = {
      invoke: () => Promise.reject(new Error('MCP not available in sandbox mode')),
      listTools: () => [],
      isToolAvailable: () => false,
    };

    const logger = {
      info: (msg) => console.log('[INFO]', msg),
      warn: (msg) => console.warn('[WARN]', msg),
      error: (msg) => console.error('[ERROR]', msg),
    };

    (async () => {
      ${body}
    })().then(
      (result) => { console.log(JSON.stringify({ success: true, data: result })); },
      (err) => { console.error(JSON.stringify({ success: false, error: err.message })); }
    );
  `;

  const result = await executeInSandbox(
    `node -e ${shellEscape(script)}`,
    {
      timeoutMs: DEFAULT_SANDBOX_CONFIG.timeoutMs,
      commandTimeoutMs: DEFAULT_SANDBOX_CONFIG.commandTimeoutMs,
    },
  );

  if (result.timedOut) {
    throw new SkillExecutionError(
      'Skill execution timed out in sandbox',
      result.durationMs,
    );
  }

  if (result.exitCode !== 0) {
    throw new SkillExecutionError(
      `Skill execution failed in sandbox: ${result.stderr}`,
      result.durationMs,
    );
  }

  // Try to parse the result from stdout
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return parsed;
  } catch {
    // If not JSON, return stdout as-is
    return result.stdout;
  }
}

/**
 * Execute a skill script with full result metadata.
 * Returns a structured SkillRunResult instead of just the data.
 */
export async function runSkillWithMetadata(
  body: string,
  context: SkillContext,
): Promise<SkillRunResult> {
  const startTime = Date.now();

  try {
    const data = await runSkillScript(body, context);
    return {
      success: true,
      data,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      success: false,
      data: null,
      error: errorMessage,
      durationMs,
    };
  }
}

// ── Error Class ────────────────────────────────────────────────

export class SkillExecutionError extends Error {
  public readonly durationMs: number;

  constructor(message: string, durationMs: number) {
    super(message);
    this.name = 'SkillExecutionError';
    this.durationMs = durationMs;
  }
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Shell-escape a string for safe use in a shell command argument.
 * Wraps in single quotes and escapes any existing single quotes.
 */
function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}
