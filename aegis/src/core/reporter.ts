/**
 * Result Reporter — Aegis
 *
 * Formats execution results and publishes them back to Vanguard
 * via NATS JetStream.
 */

import { publish } from '../ipc/nats.js';
import { NATS_SUBJECTS, redactSecrets } from '@edenvanguard/shared';
import type { ExecutionResult } from './executor.js';

// ── Crash Report ───────────────────────────────────────────────

/** Report crash diagnosis results back to Vanguard */
export async function reportCrashResult(
  threadId: string,
  result: ExecutionResult,
  diagnosis?: string,
): Promise<void> {
  await publish(NATS_SUBJECTS.CRASH_RESULT, {
    threadId,
    success: result.success,
    rolledBack: result.rolledBack,
    diagnosis: diagnosis ? redactSecrets(diagnosis) : undefined,
    stepCount: result.stepResults.length,
    successfulSteps: result.stepResults.filter((s) => s.success).length,
    failedSteps: result.stepResults.filter((s) => !s.success).length,
    totalDurationMs: result.totalDurationMs,
  });
}

// ── Suggestion Evaluation Report ───────────────────────────────

/** Report suggestion evaluation results back to Vanguard */
export async function reportSuggestionResult(
  threadId: string,
  result: ExecutionResult,
  evaluation?: string,
): Promise<void> {
  await publish(NATS_SUBJECTS.SUGGESTION_RESULT, {
    threadId,
    success: result.success,
    evaluation: evaluation ? redactSecrets(evaluation) : undefined,
    totalDurationMs: result.totalDurationMs,
  });
}

// ── Deployment Status Report ───────────────────────────────────

/** Report deployment status back to Vanguard */
export async function reportDeploymentStatus(
  jobId: string,
  status: string,
  detail?: unknown,
): Promise<void> {
  await publish(NATS_SUBJECTS.DEPLOYMENT_STATUS, {
    jobId,
    status,
    detail: detail ? redactSecrets(JSON.stringify(detail)) : undefined,
    timestamp: new Date().toISOString(),
  });
}
