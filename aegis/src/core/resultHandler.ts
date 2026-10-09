/**
 * Aegis Result Handler
 *
 * Subscribes to Aegis result subjects and formats them for
 * Vanguard to display. This is the missing piece that connects
 * Aegis output back to Discord via Vanguard.
 *
 * Listens on:
 *   - aegis.crash.result      → CrashResultPayload
 *   - aegis.suggestion.result → SuggestionResultPayload
 *   - aegis.deployment.status → DeploymentStatusPayload
 */

import { subscribe } from '../ipc/nats.js';
import { NATS_SUBJECTS, type IpcEnvelope } from '@edenvanguard/shared';

// ── Types ──────────────────────────────────────────────────────

export interface CrashResultPayload {
  threadId: string;
  success: boolean;
  diagnosis?: string;
  stepCount: number;
  successfulSteps: number;
  totalDurationMs: number;
  rolledBack: boolean;
}

export interface SuggestionResultPayload {
  threadId: string;
  success: boolean;
  evaluation?: string;
  totalDurationMs: number;
}

export interface DeploymentStatusPayload {
  jobId: string;
  status: string;
  detail?: string;
  timestamp: string;
}

/** Type for all result payloads that Vanguard can display */
export type ResultPayload = CrashResultPayload | SuggestionResultPayload | DeploymentStatusPayload;

// ── Result formatting ──────────────────────────────────────────

/** Format a crash result for Discord display */
function formatCrashResult(payload: CrashResultPayload): string {
  const status = payload.success ? '✅ Diagnosed' : '❌ Failed';
  const rollback = payload.rolledBack ? ' (rolled back)' : '';
  const steps = `${payload.successfulSteps}/${payload.stepCount} steps`;
  const duration = `${(payload.totalDurationMs / 1000).toFixed(1)}s`;

  let message = `${status}${rollback} — Crash diagnosis for thread ${payload.threadId}\n`;
  message += `Progress: ${steps} in ${duration}`;

  if (payload.diagnosis) {
    // Truncate long diagnoses for Discord message limits
    const maxLen = 1500;
    const diag = payload.diagnosis.length > maxLen
      ? payload.diagnosis.substring(0, maxLen) + '…'
      : payload.diagnosis;
    message += `\n\`\`\`\n${diag}\n\`\`\``;
  }

  return message;
}

/** Format a suggestion result for Discord display */
function formatSuggestionResult(payload: SuggestionResultPayload): string {
  const status = payload.success ? '✅ Evaluated' : '❌ Evaluation Failed';
  const duration = `${(payload.totalDurationMs / 1000).toFixed(1)}s`;

  let message = `${status} — Suggestion evaluation for thread ${payload.threadId}\n`;
  message += `Duration: ${duration}`;

  if (payload.evaluation) {
    const maxLen = 1500;
    const eval_ = payload.evaluation.length > maxLen
      ? payload.evaluation.substring(0, maxLen) + '…'
      : payload.evaluation;
    message += `\n\`\`\`\n${eval_}\n\`\`\``;
  }

  return message;
}

/** Format a deployment status for Discord display */
function formatDeploymentStatus(payload: DeploymentStatusPayload): string {
  const statusEmoji: Record<string, string> = {
    pending: '⏳',
    staging: '📦',
    ready: '🟢',
    executing: '🔧',
    completed: '✅',
    failed: '❌',
    rolled_back: '↩️',
  };

  const emoji = statusEmoji[payload.status] ?? '❓';
  let message = `${emoji} Deployment ${payload.status} — Job ${payload.jobId}`;

  if (payload.detail) {
    message += `\n${payload.detail}`;
  }

  return message;
}

// ── Result Handler ─────────────────────────────────────────────

/** Cached formatted results for Vanguard to pick up */
const resultCache = new Map<string, { subject: string; formatted: string; timestamp: string }>();

/** Get cached results (used by Vanguard poll or push) */
export function getCachedResults(): Array<{ subject: string; formatted: string; timestamp: string }> {
  return [...resultCache.values()];
}

/** Clear the result cache */
export function clearResultCache(): void {
  resultCache.clear();
}

/**
 * Start listening for Aegis results and format them for Vanguard.
 *
 * Subscribes to NATS result subjects and caches formatted messages
 * that Vanguard can retrieve and post to Discord threads.
 */
export async function startResultHandler(): Promise<void> {
  // Subscribe to crash results
  await subscribe<CrashResultPayload>(
    NATS_SUBJECTS.CRASH_RESULT,
    async (envelope: IpcEnvelope<CrashResultPayload>) => {
      const formatted = formatCrashResult(envelope.payload);
      resultCache.set(`crash:${envelope.payload.threadId}`, {
        subject: NATS_SUBJECTS.CRASH_RESULT,
        formatted,
        timestamp: envelope.timestamp,
      });
      console.error(`[ResultHandler] Crash result for thread ${envelope.payload.threadId}: ${envelope.payload.success ? 'success' : 'failed'}`);
    },
  );

  // Subscribe to suggestion results
  await subscribe<SuggestionResultPayload>(
    NATS_SUBJECTS.SUGGESTION_RESULT,
    async (envelope: IpcEnvelope<SuggestionResultPayload>) => {
      const formatted = formatSuggestionResult(envelope.payload);
      resultCache.set(`suggestion:${envelope.payload.threadId}`, {
        subject: NATS_SUBJECTS.SUGGESTION_RESULT,
        formatted,
        timestamp: envelope.timestamp,
      });
      console.error(`[ResultHandler] Suggestion result for thread ${envelope.payload.threadId}: ${envelope.payload.success ? 'success' : 'failed'}`);
    },
  );

  // Subscribe to deployment status updates
  await subscribe<DeploymentStatusPayload>(
    NATS_SUBJECTS.DEPLOYMENT_STATUS,
    async (envelope: IpcEnvelope<DeploymentStatusPayload>) => {
      const formatted = formatDeploymentStatus(envelope.payload);
      resultCache.set(`deployment:${envelope.payload.jobId}`, {
        subject: NATS_SUBJECTS.DEPLOYMENT_STATUS,
        formatted,
        timestamp: envelope.timestamp,
      });
      console.error(`[ResultHandler] Deployment ${envelope.payload.jobId}: ${envelope.payload.status}`);
    },
  );

  console.error('[ResultHandler] Subscribed to Aegis result subjects');
}
