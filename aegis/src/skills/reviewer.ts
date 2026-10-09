/**
 * Admin Review Flow Handler — Aegis
 *
 * Handles the admin review workflow for suggestions, implementing
 * the AWAITING_ADMIN → {APPROVED, REJECTED} transitions from the
 * Partial Overlap Deduplication Lifecycle (Section B, 03_state_machines.md).
 *
 * Responsibilities:
 *   - Accepts evaluation from Aegis
 *   - Formats the evaluation for Discord display
 *   - Tracks review state in suggestion_threads table
 *   - Processes admin approve/reject actions
 *   - Updates thread status on action
 */

import { db } from '../db/client.js';
import { suggestionThreads, maintenanceQueue } from '../db/schema.js';
import { eq } from 'drizzle-orm';

// ── Types ──────────────────────────────────────────────────────

export interface EvaluationResult {
  threadId: string;
  recommendation: 'approve' | 'reject' | 'needs_info';
  reasoning: string;
  conflicts: string[];
  selectedMods: Array<{
    name: string;
    id: string;
    version: string;
  }>;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ApprovalResult {
  threadId: string;
  jobId: string;
  status: 'staged';
}

export interface RejectionResult {
  threadId: string;
  status: 'rejected';
  rejectionNotice: string;
}

// ── Discord Formatting Helpers ─────────────────────────────────

const RISK_EMOJI: Record<EvaluationResult['riskLevel'], string> = {
  low: '\u{1F7E2}',    // 🟢
  medium: '\u{1F7E1}',  // 🟡
  high: '\u{1F534}',    // 🔴
};

const RECOMMENDATION_EMOJI: Record<EvaluationResult['recommendation'], string> = {
  approve: '\u2705',     // ✅
  reject: '\u274C',      // ❌
  needs_info: '\u2753',  // ❓
};

// ── Review Flow Handler ────────────────────────────────────────

export class ReviewFlowHandler {
  /**
   * Submit an evaluation for admin review.
   *
   * Implements the BUILDING_UI → AWAITING_ADMIN transition:
   * stores the evaluation data and updates the thread to
   * indicate it is awaiting admin action.
   */
  async submitEvaluation(evaluation: EvaluationResult): Promise<void> {
    const bytecodeAnalysis = {
      recommendation: evaluation.recommendation,
      reasoning: evaluation.reasoning,
      riskLevel: evaluation.riskLevel,
      conflicts: evaluation.conflicts,
      selectedMods: evaluation.selectedMods,
      evaluatedAt: new Date().toISOString(),
    };

    await db
      .update(suggestionThreads)
      .set({
        bytecodeAnalysis: bytecodeAnalysis as unknown as Record<string, unknown>,
        status: 'review',
        updatedAt: new Date(),
      })
      .where(eq(suggestionThreads.threadId, evaluation.threadId));
  }

  /**
   * Process an admin approval.
   *
   * Implements the AWAITING_ADMIN → APPROVED → STAGING transition:
   *   1. Creates a maintenance_queue job for deployment
   *   2. Links the suggestion thread to the maintenance job
   *   3. Updates thread status to 'staged'
   */
  async processApproval(
    threadId: string,
    adminId: string,
    notes?: string,
  ): Promise<ApprovalResult> {
    // Fetch the current thread to get mod identifiers and evaluation data
    const threads = await db
      .select()
      .from(suggestionThreads)
      .where(eq(suggestionThreads.threadId, threadId));

    if (threads.length === 0) {
      throw new Error(`Suggestion thread not found: ${threadId}`);
    }

    const thread = threads[0]!;
    const modIdentifiers = (thread.modIdentifiers ?? []) as Array<{
      name?: string;
      slug?: string;
      version?: string;
      status?: string;
      curseforgeId?: string;
      modrinthId?: string;
    }>;

    // Filter to only unique (non-duplicate) mods that are selected for approval
    const approvedMods = modIdentifiers.filter(
      (m) => m.status === 'unique' || m.status === undefined,
    );

    // Build staging file list
    const stagingFiles = approvedMods.map((mod) => ({
      staging_path: `/workspace/staging/mods/${mod.slug ?? mod.name}-${mod.version}.jar`,
      production_path: `/home/container/mods/${mod.slug ?? mod.name}-${mod.version}.jar`,
      file_type: 'mod_jar',
      source_suggestion_thread_id: threadId,
      mod_id: mod.curseforgeId ?? mod.modrinthId ?? mod.slug ?? mod.name,
      mod_version: mod.version ?? 'latest',
    }));

    // Determine server ID — from environment or a default
    const serverId = process.env.PTERODACTYL_SERVER_ID ?? 'default';

    // Create maintenance job
    const jobResult = await db
      .insert(maintenanceQueue)
      .values({
        pterodactylServerId: serverId,
        targetFiles: stagingFiles as unknown as Record<string, unknown>[],
        adminOverrideNotes: notes ?? null,
        approvedBy: adminId,
        status: 'pending',
      })
      .returning({ jobId: maintenanceQueue.jobId });

    const jobId = jobResult[0]?.jobId;
    if (!jobId) {
      throw new Error('Failed to create maintenance job');
    }

    // Update suggestion thread: link to maintenance job, set status to staged
    await db
      .update(suggestionThreads)
      .set({
        status: 'staged',
        adminNotes: notes ?? null,
        approvedBy: adminId,
        reviewedAt: new Date(),
        maintenanceJobId: jobId,
        updatedAt: new Date(),
      })
      .where(eq(suggestionThreads.threadId, threadId));

    return {
      threadId,
      jobId,
      status: 'staged',
    };
  }

  /**
   * Process an admin rejection.
   *
   * Implements the AWAITING_ADMIN → REJECTED → CLOSING transition:
   *   1. Records the rejection reason and admin ID
   *   2. Updates thread status to 'rejected'
   */
  async processRejection(
    threadId: string,
    adminId: string,
    notes?: string,
  ): Promise<RejectionResult> {
    const rejectionNotice = this.buildRejectionNotice(threadId, adminId, notes);

    await db
      .update(suggestionThreads)
      .set({
        status: 'rejected',
        adminNotes: notes ?? null,
        rejectedBy: adminId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(suggestionThreads.threadId, threadId));

    return {
      threadId,
      status: 'rejected',
      rejectionNotice,
    };
  }

  /**
   * Format an evaluation result for Discord display.
   *
   * Produces a markdown-structured embed body containing the
   * evaluation recommendation, risk level, selected mods,
   * conflicts, and reasoning.
   */
  formatEvaluationForDiscord(evaluation: EvaluationResult): string {
    const lines: string[] = [];

    // Header
    lines.push(
      `## ${RECOMMENDATION_EMOJI[evaluation.recommendation]} Evaluation Report`,
    );
    lines.push('');

    // Recommendation
    lines.push(
      `**Recommendation:** ${RECOMMENDATION_EMOJI[evaluation.recommendation]} \`${evaluation.recommendation.toUpperCase()}\``,
    );
    lines.push(
      `**Risk Level:** ${RISK_EMOJI[evaluation.riskLevel]} \`${evaluation.riskLevel.toUpperCase()}\``,
    );
    lines.push('');

    // Selected mods
    if (evaluation.selectedMods.length > 0) {
      lines.push('### Selected Mods');
      for (const mod of evaluation.selectedMods) {
        lines.push(`- **${mod.name}** (\`${mod.id}\` v${mod.version})`);
      }
      lines.push('');
    }

    // Conflicts
    if (evaluation.conflicts.length > 0) {
      lines.push('### \u26A0\uFE0F Conflicts Detected');
      for (const conflict of evaluation.conflicts) {
        lines.push(`- ${conflict}`);
      }
      lines.push('');
    }

    // Reasoning
    lines.push('### Reasoning');
    lines.push(evaluation.reasoning);

    return lines.join('\n');
  }

  /**
   * Build a rejection notice combining admin notes with context.
   */
  private buildRejectionNotice(
    threadId: string,
    adminId: string,
    notes?: string,
  ): string {
    const lines: string[] = [];

    lines.push('\u274C **Suggestion Rejected**');
    lines.push('');
    lines.push(`Rejected by: <@${adminId}>`);

    if (notes) {
      lines.push('');
      lines.push('**Reason:**');
      lines.push(notes);
    }

    lines.push('');
    lines.push(`Thread: <#${threadId}>`);

    return lines.join('\n');
  }
}

/** Singleton review flow handler instance */
export const reviewFlowHandler = new ReviewFlowHandler();
