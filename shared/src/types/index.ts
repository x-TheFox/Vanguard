/**
 * Shared type definitions for EdenVanguard
 */

// ── IPC Message Envelope ────────────────────────────────────

/** Unique correlation ID for tracing requests across Vanguard ↔ Aegis */
export type CorrelationId = string & { readonly __brand: unique symbol };

/** IPC message envelope for NATS JetStream communication */
export interface IpcEnvelope<T = unknown> {
  /** Unique correlation ID for request tracing */
  correlationId: CorrelationId;
  /** Timestamp when the message was created */
  timestamp: string;
  /** Source component that published the message */
  source: 'vanguard' | 'aegis';
  /** NATS subject the message was published to */
  subject: string;
  /** Message payload */
  payload: T;
}

// ── Pterodactyl Types ───────────────────────────────────────

/** Pterodactyl credential type: Application API (ptla_) or Client API (ptlc_) */
export type PteroCredentialType = 'application' | 'client';

/** Pterodactyl server power state */
export type PteroPowerState = 'starting' | 'running' | 'stopping' | 'offline';

/** Pterodactyl server resource usage */
export interface PteroServerResources {
  memoryBytes: number;
  memoryLimitBytes: number;
  cpuAbsolute: number;
  diskBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  uptime: number;
  state: PteroPowerState;
}

/** Pterodactyl server summary */
export interface PteroServer {
  uuid: string;
  identifier: string;
  name: string;
  node: string;
  isSuspended: boolean;
}

// ── MCP Types ───────────────────────────────────────────────

/** MCP tool invocation result */
export interface McpToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/** MCP tool definition */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Permission gate level for MCP tools */
export type PermissionGate = 'safe' | 'gated' | 'excluded';

// ── Discord Types ───────────────────────────────────────────

/** Suggestion thread status */
export type SuggestionStatus = 'review' | 'staged' | 'deployed' | 'rejected' | 'archived';

/** Maintenance job status */
export type MaintenanceJobStatus =
  | 'pending'
  | 'staging'
  | 'ready'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'rolled_back';

/** Deployment step in the maintenance lifecycle */
export type DeploymentStep =
  | 'backup_create'
  | 'backup_verify'
  | 'file_swap'
  | 'server_stop'
  | 'server_start'
  | 'health_check'
  | 'tps_validation'
  | 'rollback';

// ── LLM Inference Types ─────────────────────────────────────

/** LLM provider type */
export type LlmProvider = 'groq' | 'opencode_zen';

/** Inference request */
export interface InferenceRequest {
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  temperature?: number;
  maxTokens?: number;
  correlationId: CorrelationId;
}

/** Inference response */
export interface InferenceResponse {
  content: string;
  provider: LlmProvider;
  model: string;
  tokensUsed: number;
  correlationId: CorrelationId;
}

// ── Skill Engine Types ──────────────────────────────────────

/** Skill file with YAML frontmatter */
export interface SkillFile {
  name: string;
  description: string;
  version: string;
  author: string;
  triggers: string[];
  tools: string[];
  body: string;
}
