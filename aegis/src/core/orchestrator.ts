/**
 * Orchestrator — Aegis Main Coordinator
 *
 * The orchestrator is the top-level coordinator. It subscribes to NATS
 * subjects, receives tasks from Vanguard, delegates to the planner,
 * executor, and reporter.
 */

import { subscribe, connectNats } from '../ipc/nats.js';
import { mcpClient } from '../mcp/clientManager.js';
import { planCrashDiagnosis, planSuggestionEvaluation, planDeployment } from './planner.js';
import { executePlan, type ExecutionResult } from './executor.js';
import { reportCrashResult, reportSuggestionResult, reportDeploymentStatus } from './reporter.js';
import { inferenceClient } from '../inference/client.js';
import { db } from '../db/client.js';
import { maintenanceQueue } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { NATS_SUBJECTS, type IpcEnvelope } from '@edenvanguard/shared';

// ── Task Payload Types ─────────────────────────────────────────

interface CrashTaskPayload {
  threadId: string;
  channelId: string;
  guildId: string;
  reporterId: string;
  crashContent: string;
  sourceType: string;
}

interface SuggestionTaskPayload {
  threadId: string;
  title: string;
  description: string;
  authorId: string;
  tags: string[];
  messageId?: string;
}

interface AdminCommandPayload {
  command: string;
  jobId?: string;
  threadId?: string;
  force?: boolean;
  requestedBy: string;
}

// ── Orchestrator Start ─────────────────────────────────────────

/** Start the Aegis orchestrator */
export async function start(): Promise<void> {
  // Connect to NATS
  await connectNats();

  // Initialize MCP client connections
  await mcpClient.initialize();

  console.error('Aegis orchestrator started');

  // Subscribe to crash report tasks from Vanguard
  await subscribe(NATS_SUBJECTS.CRASH_NEW, async (envelope: IpcEnvelope<CrashTaskPayload>) => {
    console.error(`Received crash task: thread=${envelope.payload.threadId}`);
    await handleCrashTask(envelope.payload);
  });

  // Subscribe to suggestion evaluation tasks
  await subscribe(
    NATS_SUBJECTS.SUGGESTION_NEW,
    async (envelope: IpcEnvelope<SuggestionTaskPayload>) => {
      console.error(`Received suggestion task: thread=${envelope.payload.threadId}`);
      await handleSuggestionTask(envelope.payload);
    },
  );

  // Subscribe to admin commands
  await subscribe(
    NATS_SUBJECTS.ADMIN_COMMAND,
    async (envelope: IpcEnvelope<AdminCommandPayload>) => {
      console.error(`Received admin command: ${envelope.payload.command}`);
      await handleAdminCommand(envelope.payload);
    },
  );
}

// ── Crash Task Handler ─────────────────────────────────────────

async function handleCrashTask(payload: CrashTaskPayload): Promise<void> {
  try {
    // Create a diagnostic plan
    const plan = await planCrashDiagnosis(payload.crashContent);

    // Execute the plan
    const result = await executePlan(plan);

    // Use LLM to synthesize a diagnosis from the step results
    let diagnosis: string | undefined;
    if (result.success) {
      const response = await inferenceClient.chat({
        messages: [
          {
            role: 'system',
            content:
              'You are a Minecraft server diagnostic expert. Based on the diagnostic results, provide a clear, actionable diagnosis and fix for the player. Keep it concise and practical.',
          },
          {
            role: 'user',
            content: `Crash report:\n${payload.crashContent.substring(0, 4000)}\n\nDiagnostic results:\n${JSON.stringify(result.stepResults.map((s) => ({ step: s.stepId, success: s.success, data: s.data }))).substring(0, 4000)}`,
          },
        ],
        correlationId: plan.planId,
      });
      diagnosis = response.content;
    }

    // Report back to Vanguard
    await reportCrashResult(payload.threadId, result, diagnosis);
  } catch (error) {
    console.error('Error handling crash task:', error);
    await reportCrashResult(payload.threadId, {
      planId: 'error' as unknown as ExecutionResult['planId'],
      success: false,
      stepResults: [],
      totalDurationMs: 0,
      rolledBack: false,
    });
  }
}

// ── Suggestion Task Handler ────────────────────────────────────

async function handleSuggestionTask(payload: SuggestionTaskPayload): Promise<void> {
  try {
    const plan = await planSuggestionEvaluation(payload);
    const result = await executePlan(plan);

    // Report back to Vanguard
    await reportSuggestionResult(
      payload.threadId,
      result,
      result.stepResults[0]?.data as string | undefined,
    );
  } catch (error) {
    console.error('Error handling suggestion task:', error);
    await reportSuggestionResult(payload.threadId, {
      planId: 'error' as unknown as ExecutionResult['planId'],
      success: false,
      stepResults: [],
      totalDurationMs: 0,
      rolledBack: false,
    });
  }
}

// ── Admin Command Handler ──────────────────────────────────────

async function handleAdminCommand(payload: AdminCommandPayload): Promise<void> {
  try {
    switch (payload.command) {
      case 'deploy': {
        if (!payload.jobId) throw new Error('Missing job_id');
        // Look up the maintenance job
        const jobs = await db
          .select()
          .from(maintenanceQueue)
          .where(eq(maintenanceQueue.jobId, payload.jobId));
        if (jobs.length === 0) throw new Error(`Job not found: ${payload.jobId}`);

        const job = jobs[0]!;
        const stagedFiles = (job.targetFiles ?? []) as unknown[];
        const plan = planDeployment(job.jobId, job.pterodactylServerId, stagedFiles, true);
        const result = await executePlan(plan);

        await reportDeploymentStatus(payload.jobId, result.success ? 'completed' : 'failed', result);
        break;
      }
      case 'force_rollback': {
        if (!payload.jobId) throw new Error('Missing job_id');
        await reportDeploymentStatus(payload.jobId, 'rolling_back');
        break;
      }
      case 'suggestion_approve': {
        if (!payload.threadId) throw new Error('Missing thread_id');
        // Update suggestion status to staged
        // (The full dedup flow is in Phase 6)
        console.error(`Suggestion approved: ${payload.threadId}`);
        break;
      }
      case 'suggestion_reject': {
        if (!payload.threadId) throw new Error('Missing thread_id');
        // Update suggestion status to rejected
        console.error(`Suggestion rejected: ${payload.threadId}`);
        break;
      }
      default:
        console.error(`Unknown admin command: ${payload.command}`);
    }
  } catch (error) {
    console.error('Error handling admin command:', error);
  }
}
