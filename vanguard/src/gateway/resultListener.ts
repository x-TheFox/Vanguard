/**
 * Vanguard Result Listener
 *
 * Subscribes to Aegis result NATS subjects and posts updates
 * to Discord threads. This is the Vanguard-side counterpart to
 * Aegis's ResultHandler.
 *
 * Listens on:
 *   - aegis.crash.result      → Posts diagnosis to crash thread
 *   - aegis.suggestion.result → Posts evaluation to suggestion thread
 *   - aegis.deployment.status → Posts deployment status to job thread
 */

import { subscribe } from '../ipc/nats.js';
import { NATS_SUBJECTS, type IpcEnvelope } from '@edenvanguard/shared';
import type { Client, ThreadChannel } from 'discord.js';

// ── Types ──────────────────────────────────────────────────────

interface CrashResultPayload {
  threadId: string;
  success: boolean;
  diagnosis?: string;
  stepCount: number;
  successfulSteps: number;
  totalDurationMs: number;
  rolledBack: boolean;
}

interface SuggestionResultPayload {
  threadId: string;
  success: boolean;
  evaluation?: string;
  totalDurationMs: number;
}

interface DeploymentStatusPayload {
  jobId: string;
  status: string;
  detail?: string;
  timestamp: string;
}

// ── Discord Helpers ────────────────────────────────────────────

/** Find a Discord thread channel by its ID */
async function findThread(client: Client, threadId: string): Promise<ThreadChannel | null> {
  try {
    const channel = await client.channels.fetch(threadId);
    if (channel?.isThread()) {
      return channel as ThreadChannel;
    }
    return null;
  } catch {
    return null;
  }
}

/** Send a message to a Discord thread, with error handling */
async function sendToThread(client: Client, threadId: string, message: string): Promise<boolean> {
  const thread = await findThread(client, threadId);
  if (!thread) {
    console.error(`[ResultListener] Thread ${threadId} not found or not accessible`);
    return false;
  }

  try {
    // Discord message limit is 2000 chars; split if needed
    if (message.length <= 2000) {
      await thread.send(message);
    } else {
      // Split on newline boundaries
      const chunks = splitMessage(message, 1900);
      for (const chunk of chunks) {
        await thread.send(chunk);
      }
    }
    return true;
  } catch (error) {
    console.error(`[ResultListener] Failed to send to thread ${threadId}:`, error);
    return false;
  }
}

/** Split a message into chunks that fit Discord's 2000 char limit */
function splitMessage(message: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = message;

  while (remaining.length > maxLen) {
    // Find a good split point (newline) near the limit
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) {
      // No good newline found; split at maxLen
      splitAt = maxLen;
    }
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

// ── Formatting ─────────────────────────────────────────────────

function formatCrashResult(payload: CrashResultPayload): string {
  const status = payload.success ? '✅ Diagnosed' : '❌ Failed';
  const rollback = payload.rolledBack ? ' (rolled back)' : '';
  let msg = `${status}${rollback} — Crash Diagnosis\n`;
  msg += `Steps: ${payload.successfulSteps}/${payload.stepCount} in ${(payload.totalDurationMs / 1000).toFixed(1)}s`;
  if (payload.diagnosis) {
    const maxLen = 1500;
    const diag = payload.diagnosis.length > maxLen
      ? payload.diagnosis.substring(0, maxLen) + '…'
      : payload.diagnosis;
    msg += `\n\`\`\`\n${diag}\n\`\`\``;
  }
  return msg;
}

function formatSuggestionResult(payload: SuggestionResultPayload): string {
  const status = payload.success ? '✅ Evaluated' : '❌ Evaluation Failed';
  let msg = `${status} — Suggestion Evaluation\n`;
  msg += `Duration: ${(payload.totalDurationMs / 1000).toFixed(1)}s`;
  if (payload.evaluation) {
    const maxLen = 1500;
    const ev = payload.evaluation.length > maxLen
      ? payload.evaluation.substring(0, maxLen) + '…'
      : payload.evaluation;
    msg += `\n\`\`\`\n${ev}\n\`\`\``;
  }
  return msg;
}

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
  let msg = `${emoji} Deployment **${payload.status}** — Job \`${payload.jobId}\``;
  if (payload.detail) {
    msg += `\n${payload.detail}`;
  }
  return msg;
}

// ── Result Listener Registration ───────────────────────────────

/**
 * Register the Aegis result listener that posts updates to Discord.
 *
 * Subscribes to Aegis NATS result subjects and sends formatted
 * messages to the appropriate Discord threads.
 */
export function registerResultListener(client: Client): void {
  // Crash results → post to crash thread
  subscribe<CrashResultPayload>(
    NATS_SUBJECTS.CRASH_RESULT,
    async (envelope: IpcEnvelope<CrashResultPayload>) => {
      const { threadId } = envelope.payload;
      const formatted = formatCrashResult(envelope.payload);
      await sendToThread(client, threadId, formatted);
    },
  ).catch((err) => {
    console.error('[ResultListener] Failed to subscribe to crash results:', err);
  });

  // Suggestion results → post to suggestion thread
  subscribe<SuggestionResultPayload>(
    NATS_SUBJECTS.SUGGESTION_RESULT,
    async (envelope: IpcEnvelope<SuggestionResultPayload>) => {
      const { threadId } = envelope.payload;
      const formatted = formatSuggestionResult(envelope.payload);
      await sendToThread(client, threadId, formatted);
    },
  ).catch((err) => {
    console.error('[ResultListener] Failed to subscribe to suggestion results:', err);
  });

  // Deployment status → post to job thread (using jobId as threadId)
  subscribe<DeploymentStatusPayload>(
    NATS_SUBJECTS.DEPLOYMENT_STATUS,
    async (envelope: IpcEnvelope<DeploymentStatusPayload>) => {
      const { jobId } = envelope.payload;
      const formatted = formatDeploymentStatus(envelope.payload);
      await sendToThread(client, jobId, formatted);
    },
  ).catch((err) => {
    console.error('[ResultListener] Failed to subscribe to deployment status:', err);
  });

  console.error('[ResultListener] Registered Aegis result listeners');
}
