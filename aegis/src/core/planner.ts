/**
 * Task Planner — Aegis
 *
 * Receives a task from the orchestrator and creates an execution plan —
 * a sequence of steps with tool invocations. Plans can be created via
 * LLM-assisted analysis (crash diagnosis, suggestion evaluation) or
 * built deterministically (deployment).
 */

import { inferenceClient } from '../inference/client.js';
import { mcpClient } from '../mcp/clientManager.js';
import { createCorrelationId } from '@edenvanguard/shared';
import type { CorrelationId } from '@edenvanguard/shared';

// ── Plan Types ─────────────────────────────────────────────────

export interface PlanStep {
  stepId: number;
  description: string;
  toolName: string;
  params: Record<string, unknown>;
  dependsOn: number[]; // Step IDs this step depends on
  isRequired: boolean; // If true, failure aborts the plan
}

export interface ExecutionPlan {
  planId: CorrelationId;
  taskType: string;
  steps: PlanStep[];
  rollbackSteps: PlanStep[];
  createdAt: string;
}

// ── Crash Diagnosis Planner ────────────────────────────────────

/** Create an execution plan for a crash diagnosis task */
export async function planCrashDiagnosis(crashContent: string): Promise<ExecutionPlan> {
  const availableTools = mcpClient.listAvailableTools();

  // Use LLM to analyze crash and create a plan
  const response = await inferenceClient.chat({
    messages: [
      {
        role: 'system',
        content: `You are a Minecraft server diagnostic planner. Given a crash report, create a step-by-step diagnostic plan using the available MCP tools. Available tools: ${availableTools.join(', ')}. Respond with a JSON array of steps, each with: description, toolName, params, isRequired. Only use tools from the available list.`,
      },
      {
        role: 'user',
        content: `Analyze this crash report and create a diagnostic plan:\n\n${crashContent.substring(0, 8000)}`,
      },
    ],
    correlationId: createCorrelationId(),
  });

  // Parse the plan from the LLM response
  let steps: PlanStep[];
  try {
    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const rawSteps = JSON.parse(jsonMatch[0]) as Array<{
        description: string;
        toolName: string;
        params: Record<string, unknown>;
        isRequired: boolean;
      }>;
      steps = rawSteps.map((s, i) => ({
        stepId: i + 1,
        description: s.description,
        toolName: s.toolName,
        params: s.params,
        dependsOn: i > 0 ? [i] : [],
        isRequired: s.isRequired ?? true,
      }));
    } else {
      // Fallback: basic diagnostic plan
      steps = createFallbackCrashPlan();
    }
  } catch {
    steps = createFallbackCrashPlan();
  }

  return {
    planId: createCorrelationId(),
    taskType: 'crash_diagnosis',
    steps,
    rollbackSteps: [],
    createdAt: new Date().toISOString(),
  };
}

// ── Suggestion Evaluation Planner ──────────────────────────────

/** Create an execution plan for a suggestion evaluation */
export async function planSuggestionEvaluation(suggestion: {
  title: string;
  description: string;
  threadId: string;
}): Promise<ExecutionPlan> {
  const availableTools = mcpClient.listAvailableTools();

  const response = await inferenceClient.chat({
    messages: [
      {
        role: 'system',
        content: `You are a Minecraft mod suggestion evaluator. Given a suggestion, evaluate its merit, check for conflicts with existing mods, and determine if it should be approved. Available tools: ${availableTools.join(', ')}. Respond with a JSON evaluation including: recommendation (approve/reject), reasoning, conflicts, and any tool invocations needed.`,
      },
      {
        role: 'user',
        content: `Evaluate this mod suggestion:\nTitle: ${suggestion.title}\nDescription: ${suggestion.description}`,
      },
    ],
    correlationId: createCorrelationId(),
  });

  return {
    planId: createCorrelationId(),
    taskType: 'suggestion_evaluation',
    steps: [
      {
        stepId: 1,
        description: 'Evaluate suggestion using LLM analysis',
        toolName: '__llm_evaluation__', // Special marker — handled directly by executor
        params: { evaluation: response.content },
        dependsOn: [],
        isRequired: true,
      },
    ],
    rollbackSteps: [],
    createdAt: new Date().toISOString(),
  };
}

// ── Deployment Planner ─────────────────────────────────────────

/** Create a deployment execution plan */
export function planDeployment(
  jobId: string,
  serverId: string,
  stagedFiles: unknown[],
  backupFirst: boolean = true,
): ExecutionPlan {
  const steps: PlanStep[] = [];
  let stepId = 1;

  if (backupFirst) {
    steps.push({
      stepId: stepId++,
      description: 'Create pre-deployment backup',
      toolName: 'create_backup',
      params: { server_id: serverId, name: `pre-deploy-${jobId}` },
      dependsOn: [],
      isRequired: true,
    });
    steps.push({
      stepId: stepId++,
      description: 'Verify backup completed',
      toolName: 'get_backup_status',
      params: { server_id: serverId },
      dependsOn: [1],
      isRequired: true,
    });
  }

  // File swap: upload new mod files
  for (const file of stagedFiles) {
    steps.push({
      stepId: stepId++,
      description: `Upload file: ${String(file)}`,
      toolName: 'upload_file',
      params: { server_id: serverId, path: String(file) },
      dependsOn: backupFirst ? [2] : [],
      isRequired: true,
    });
  }

  // Stop server
  steps.push({
    stepId: stepId++,
    description: 'Stop server for deployment',
    toolName: 'stop_server',
    params: { server_id: serverId, confirm: true },
    dependsOn: [stepId - 2],
    isRequired: true,
  });

  // Start server
  steps.push({
    stepId: stepId++,
    description: 'Start server after deployment',
    toolName: 'start_server',
    params: { server_id: serverId },
    dependsOn: [stepId - 1],
    isRequired: true,
  });

  // Health check
  steps.push({
    stepId: stepId++,
    description: 'Check server resources after startup',
    toolName: 'get_server_resources',
    params: { server_id: serverId },
    dependsOn: [stepId - 1],
    isRequired: true,
  });

  // Rollback plan
  const rollbackSteps: PlanStep[] = [
    {
      stepId: 1,
      description: 'Stop server for rollback',
      toolName: 'stop_server',
      params: { server_id: serverId, confirm: true },
      dependsOn: [],
      isRequired: true,
    },
    {
      stepId: 2,
      description: 'Restore from pre-deployment backup',
      toolName: 'restore_backup',
      params: { server_id: serverId, confirm: true },
      dependsOn: [1],
      isRequired: true,
    },
    {
      stepId: 3,
      description: 'Start server after rollback',
      toolName: 'start_server',
      params: { server_id: serverId },
      dependsOn: [2],
      isRequired: true,
    },
  ];

  return {
    planId: createCorrelationId(),
    taskType: 'deployment',
    steps,
    rollbackSteps,
    createdAt: new Date().toISOString(),
  };
}

// ── Fallback Plan ──────────────────────────────────────────────

function createFallbackCrashPlan(): PlanStep[] {
  return [
    {
      stepId: 1,
      description: 'List servers to identify target',
      toolName: 'list_servers',
      params: {},
      dependsOn: [],
      isRequired: true,
    },
    {
      stepId: 2,
      description: 'Get server resources',
      toolName: 'get_server_resources',
      params: {},
      dependsOn: [1],
      isRequired: false,
    },
  ];
}
