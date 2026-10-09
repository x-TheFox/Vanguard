/**
 * Cron Job Scheduler — Aegis
 *
 * Manages scheduled tasks such as:
 *   - Telemetry collection
 *   - Health checks
 *   - Drift detection
 *   - Deployment queue processing
 *
 * The scheduler checks the `cron_jobs` table every 60 seconds for due jobs
 * and dispatches the appropriate handler.
 */

import { db } from '../db/client.js';
import { cronJobs } from '../db/schema.js';
import { eq, and, lte } from 'drizzle-orm';
import { deploymentManager } from './deploymentManager.js';
import { reportDeploymentStatus } from '../core/reporter.js';

// ── Task Handler Registry ─────────────────────────────────────────

type TaskHandler = (taskType: string, taskConfig: unknown) => Promise<void>;

const taskHandlers = new Map<string, TaskHandler>();

/** Register a task handler for a given task type */
export function registerTaskHandler(taskType: string, handler: TaskHandler): void {
  taskHandlers.set(taskType, handler);
}

// ── Built-in Handlers ─────────────────────────────────────────────

/** Handler: process the deployment queue */
async function handleDeploymentQueue(): Promise<void> {
  await deploymentManager.processQueue();
}

/** Handler: run a server health check */
async function handleHealthCheck(taskConfig: unknown): Promise<void> {
  const config = taskConfig as { serverId?: string };
  if (!config.serverId) {
    console.warn('[CronScheduler] Health check missing serverId in config');
    return;
  }
  await reportDeploymentStatus('health-check', 'running', {
    serverId: config.serverId,
  });
}

/** Handler: run drift detection */
async function handleDriftDetection(taskConfig: unknown): Promise<void> {
  const config = taskConfig as { serverId?: string };
  if (!config.serverId) {
    console.warn('[CronScheduler] Drift detection missing serverId in config');
    return;
  }
  await reportDeploymentStatus('drift-detection', 'running', {
    serverId: config.serverId,
  });
}

// ── CronScheduler ─────────────────────────────────────────────────

export class CronScheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private mainTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /**
   * Start the scheduler — checks for due jobs every 60 seconds.
   *
   * Also seeds the built-in task handlers and creates default cron jobs
   * if they don't already exist.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Register built-in handlers
    registerTaskHandler('deployment_queue', handleDeploymentQueue);
    registerTaskHandler('health_check', handleHealthCheck);
    registerTaskHandler('drift_detection', handleDriftDetection);

    // Main tick loop: every 60 seconds
    this.mainTimer = setInterval(() => {
      this.tick().catch((error) => {
        console.error('[CronScheduler] Tick error:', error);
      });
    }, 60_000);

    // Run the first tick immediately
    this.tick().catch((error) => {
      console.error('[CronScheduler] Initial tick error:', error);
    });

    console.error('[CronScheduler] Started — checking every 60 seconds');
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.mainTimer !== null) {
      clearInterval(this.mainTimer);
      this.mainTimer = null;
    }

    for (const [name, timer] of this.timers) {
      clearInterval(timer);
      console.error(`[CronScheduler] Stopped timer: ${name}`);
    }
    this.timers.clear();
    this.running = false;

    console.error('[CronScheduler] Stopped');
  }

  /**
   * Check for and execute due cron jobs.
   *
   * A job is "due" when:
   *   - It is active
   *   - Its nextRunAt is in the past (or null)
   */
  private async tick(): Promise<void> {
    const now = new Date();

    // Find all active jobs that are due
    const dueJobs = await db
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.isActive, true), lte(cronJobs.nextRunAt, now)));

    for (const job of dueJobs) {
      try {
        await this.executeJob(job.jobId, job.name, job.cronExpression, job.failureCount, job.maxFailures);
      } catch (error) {
        console.error(`[CronScheduler] Error executing job ${job.name}:`, error);
      }
    }
  }

  /**
   * Execute a single cron job by looking up its handler and invoking it.
   */
  private async executeJob(
    jobId: string,
    jobName: string,
    _cronExpression: string,
    currentFailures: number,
    maxFailures: number,
  ): Promise<void> {
    // Determine the task type from the job name
    // Convention: job name format is "task_type:optional_label"
    const taskType = jobName.split(':')[0] ?? jobName;

    const handler = taskHandlers.get(taskType);
    if (!handler) {
      console.warn(`[CronScheduler] No handler for task type: ${taskType}`);
      return;
    }

    try {
      await handler(taskType, { jobId, jobName });

      // On success: reset failure count and schedule next run
      const nextRun = this.calculateNextRun(_cronExpression);
      await db
        .update(cronJobs)
        .set({
          lastRunAt: new Date(),
          nextRunAt: nextRun,
          failureCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(cronJobs.jobId, jobId));
    } catch (error) {
      const newFailureCount = currentFailures + 1;

      if (newFailureCount >= maxFailures) {
        // Job has exceeded max failures — disable it
        console.error(
          `[CronScheduler] Job ${jobName} exceeded max failures (${maxFailures}). Disabling.`,
        );

        await db
          .update(cronJobs)
          .set({
            isActive: false,
            failureCount: newFailureCount,
            updatedAt: new Date(),
          })
          .where(eq(cronJobs.jobId, jobId));
      } else {
        // Increment failure count but keep active
        await db
          .update(cronJobs)
          .set({
            failureCount: newFailureCount,
            updatedAt: new Date(),
          })
          .where(eq(cronJobs.jobId, jobId));
      }

      console.error(`[CronScheduler] Job ${jobName} failed (attempt ${newFailureCount}/${maxFailures}):`, error);
    }
  }

  /**
   * Calculate the next run time from a cron expression.
   *
   * For simplicity, this implements a basic interval-based calculation
   * for common patterns. A full cron parser could replace this in production.
   */
  private calculateNextRun(cronExpression: string): Date {
    const now = new Date();

    // Parse simple interval patterns: "*/N * * * * *" or "*/N * * * *"
    const intervalMatch = cronExpression.match(/^\*\/(\d+)\s/);
    if (intervalMatch?.[1]) {
      const intervalSeconds = parseInt(intervalMatch[1], 10);
      return new Date(now.getTime() + intervalSeconds * 1000);
    }

    // Default: 60 seconds from now
    return new Date(now.getTime() + 60_000);
  }

  /**
   * Register a new cron job in the database.
   * Returns the new job's ID.
   */
  async registerJob(
    name: string,
    schedule: string,
    taskType: string,
    _taskConfig: unknown,
  ): Promise<string> {
    // Build the job name with task type prefix
    const jobName = `${taskType}:${name}`;

    const nextRun = this.calculateNextRun(schedule);

    const result = await db
      .insert(cronJobs)
      .values({
        name: jobName,
        description: `Cron job for ${taskType}: ${name}`,
        cronExpression: schedule,
        isActive: true,
        nextRunAt: nextRun,
        failureCount: 0,
        maxFailures: 3,
      })
      .returning({ jobId: cronJobs.jobId });

    const jobId = result[0]?.jobId;
    if (!jobId) {
      throw new Error('Failed to create cron job');
    }

    // Ensure a handler is registered for this task type
    if (!taskHandlers.has(taskType)) {
      console.warn(
        `[CronScheduler] No handler registered for task type '${taskType}'. ` +
          `Register one with registerTaskHandler() before the next tick.`,
      );
    }

    console.error(`[CronScheduler] Registered job '${jobName}' (${jobId}), next run: ${nextRun.toISOString()}`);
    return jobId;
  }

  /**
   * Unregister (soft-delete) a cron job by setting it inactive.
   */
  async unregisterJob(jobId: string): Promise<void> {
    await db
      .update(cronJobs)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(cronJobs.jobId, jobId));

    // Also clear any in-memory timer
    const timer = this.timers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(jobId);
    }

    console.error(`[CronScheduler] Unregistered job ${jobId}`);
  }
}

// ── Singleton ─────────────────────────────────────────────────────

export const cronScheduler = new CronScheduler();
