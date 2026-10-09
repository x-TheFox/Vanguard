/**
 * Plan Executor — Aegis
 *
 * Executes an ExecutionPlan step by step, respecting dependencies,
 * handling failures, and triggering rollback on critical step failure.
 */

import { mcpClient } from '../mcp/clientManager.js';
import { redactSecrets } from '@edenvanguard/shared';
import type { ExecutionPlan, PlanStep } from './planner.js';

// ── Types ──────────────────────────────────────────────────────

export interface StepResult {
  stepId: number;
  success: boolean;
  data: unknown;
  error?: string;
  durationMs: number;
}

export interface ExecutionResult {
  planId: string;
  success: boolean;
  stepResults: StepResult[];
  totalDurationMs: number;
  rolledBack: boolean;
}

// ── Plan Execution ─────────────────────────────────────────────

/** Execute an ExecutionPlan, respecting step dependencies */
export async function executePlan(plan: ExecutionPlan): Promise<ExecutionResult> {
  const startTime = Date.now();
  const stepResults: StepResult[] = [];
  const completedSteps = new Set<number>();
  const failedSteps = new Set<number>();

  // Execute steps in dependency order
  const stepsRemaining = [...plan.steps];

  while (stepsRemaining.length > 0) {
    // Find steps whose dependencies are all met
    const readySteps = stepsRemaining.filter((step) => {
      const depsMet = step.dependsOn.every((dep) => completedSteps.has(dep));
      const blockedByRequiredFailure = step.dependsOn.some(
        (dep) => failedSteps.has(dep) && plan.steps.find((s) => s.stepId === dep)?.isRequired,
      );
      return depsMet && !blockedByRequiredFailure;
    });

    if (readySteps.length === 0) {
      // No more steps can execute — either all done or blocked by failures
      break;
    }

    // Execute ready steps (sequentially for safety)
    for (const step of readySteps) {
      const result = await executeStep(step);
      stepResults.push(result);

      if (result.success) {
        completedSteps.add(step.stepId);
      } else {
        failedSteps.add(step.stepId);
        if (step.isRequired) {
          // Critical failure — trigger rollback
          console.error(`Critical step ${step.stepId} failed: ${result.error}`);
          const rollbackResult = await executeRollback(plan);
          return {
            planId: plan.planId,
            success: false,
            stepResults,
            totalDurationMs: Date.now() - startTime,
            rolledBack: rollbackResult,
          };
        }
      }

      // Remove executed step from remaining
      const idx = stepsRemaining.findIndex((s) => s.stepId === step.stepId);
      if (idx !== -1) {
        stepsRemaining.splice(idx, 1);
      }
    }
  }

  const hasRequiredFailure = [...failedSteps].some(
    (id) => plan.steps.find((s) => s.stepId === id)?.isRequired,
  );

  return {
    planId: plan.planId,
    success: !hasRequiredFailure,
    stepResults,
    totalDurationMs: Date.now() - startTime,
    rolledBack: false,
  };
}

// ── Step Execution ─────────────────────────────────────────────

/** Execute a single plan step */
async function executeStep(step: PlanStep): Promise<StepResult> {
  const startTime = Date.now();

  try {
    let data: unknown;

    if (step.toolName === '__llm_evaluation__') {
      // Special case: LLM evaluation step
      data = step.params;
    } else {
      // MCP tool invocation
      data = await mcpClient.invoke(step.toolName, step.params);
    }

    return {
      stepId: step.stepId,
      success: true,
      data,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      stepId: step.stepId,
      success: false,
      data: null,
      error: redactSecrets(String(error)),
      durationMs: Date.now() - startTime,
    };
  }
}

// ── Rollback ───────────────────────────────────────────────────

/** Execute rollback steps */
async function executeRollback(plan: ExecutionPlan): Promise<boolean> {
  console.error(`Executing rollback for plan ${plan.planId}`);

  for (const step of plan.rollbackSteps) {
    try {
      await mcpClient.invoke(step.toolName, step.params);
    } catch (error) {
      console.error(`Rollback step ${step.stepId} failed:`, redactSecrets(String(error)));
      return false; // Rollback failed
    }
  }

  return true; // Rollback succeeded
}
