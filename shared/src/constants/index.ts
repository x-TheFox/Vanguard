/**
 * Shared constants for EdenVanguard
 */

// ── NATS Subjects ───────────────────────────────────────────

export const NATS_SUBJECTS = {
  /** Vanguard publishes crash report detections */
  CRASH_NEW: 'vanguard.crash.new',
  /** Vanguard publishes new suggestion threads */
  SUGGESTION_NEW: 'vanguard.suggestion.new',
  /** Vanguard publishes admin commands */
  ADMIN_COMMAND: 'vanguard.admin.command',

  /** Aegis publishes diagnostic results */
  CRASH_RESULT: 'aegis.crash.result',
  /** Aegis publishes suggestion evaluation results */
  SUGGESTION_RESULT: 'aegis.suggestion.result',
  /** Aegis publishes deployment status updates */
  DEPLOYMENT_STATUS: 'aegis.deployment.status',
  /** Aegis publishes general status messages */
  STATUS: 'aegis.status',

  /** Pterodactyl MCP server credential reload signal */
  PTERO_RELOAD_CREDENTIALS: 'ptero-mcp.reload-credentials',
} as const;

// ── Permission Levels ───────────────────────────────────────

export const PERMISSION_LEVELS = {
  /** Safe: autonomous execution allowed */
  SAFE: 'safe' as const,
  /** Gated: requires explicit confirmation */
  GATED: 'gated' as const,
  /** Excluded: never exposed as MCP tool */
  EXCLUDED: 'excluded' as const,
} as const;

// ── Rate Limit Constants ────────────────────────────────────

export const RATE_LIMITS = {
  /** Pterodactyl API default: 240 requests/minute per key */
  PTERO_RPM_PER_KEY: 240,
  /** Proactive throttle threshold — stop using key when remaining <= this */
  PTERO_THROTTLE_THRESHOLD: 20,
  /** WebSocket JWT refresh interval in milliseconds (refresh at 8 min for 10-min expiry) */
  PTERO_WS_JWT_REFRESH_MS: 8 * 60 * 1000,
  /** WebSocket JWT expiry in milliseconds */
  PTERO_WS_JWT_EXPIRY_MS: 10 * 60 * 1000,
  /** Maximum WebSocket reconnect attempts */
  PTERO_WS_MAX_RECONNECTS: 5,
  /** Console command rate: max 10 commands per 5 seconds */
  CONSOLE_COMMAND_WINDOW_MS: 5000,
  CONSOLE_COMMAND_MAX_PER_WINDOW: 10,
  /** Backup poll interval in milliseconds */
  BACKUP_POLL_INTERVAL_MS: 5000,
  /** Backup poll timeout in milliseconds */
  BACKUP_POLL_TIMEOUT_MS: 10 * 60 * 1000,
} as const;

// ── Deployment Constants ────────────────────────────────────

export const DEPLOYMENT = {
  /** TPS threshold below which deployment is considered failed */
  TPS_FAILURE_THRESHOLD: 15,
  /** Number of TPS samples required for validation */
  TPS_SAMPLE_COUNT: 3,
  /** Interval between TPS samples in milliseconds */
  TPS_SAMPLE_INTERVAL_MS: 10_000,
  /** Maximum deployment duration in milliseconds */
  MAX_DURATION_MS: 30 * 60 * 1000,
  /** In-game warning duration before server stop in seconds */
  PRE_STOP_WARNING_SECONDS: 10,
} as const;

// ── Safety Constants ────────────────────────────────────────

export const SAFETY = {
  /** Regex patterns for secret detection */
  SECRET_PATTERNS: [
    /ptla_[A-Za-z0-9]+/,
    /ptlc_[A-Za-z0-9]+/,
    /sk-[A-Za-z0-9]+/,
    /xai-[A-Za-z0-9]+/,
    /gsk_[A-Za-z0-9]+/,
    /ENCRYPTION_KEY/i,
  ],
  /** Blocked console command patterns */
  BLOCKED_COMMANDS: [/^op\s/i, /^deop\s/i],
  /** Protected directory paths (no write/delete allowed) */
  PROTECTED_PATHS: ['/backups/', '.env', '/.ssh/'],
  /** Maximum file size for write_file tool in bytes (5MB) */
  MAX_WRITE_FILE_BYTES: 5 * 1024 * 1024,
  /** Maximum console buffer size in lines */
  MAX_CONSOLE_BUFFER_LINES: 200,
} as const;

// ── Circuit Breaker ─────────────────────────────────────────

export const CIRCUIT_BREAKER = {
  /** Number of consecutive failures before circuit opens */
  FAILURE_THRESHOLD: 5,
  /** Time to wait before half-open probe in milliseconds */
  HALF_OPEN_DELAY_MS: 30_000,
  /** MCP tool invocation timeout in milliseconds */
  TOOL_TIMEOUT_MS: 60_000,
} as const;
