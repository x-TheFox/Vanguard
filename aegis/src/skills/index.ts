/**
 * Aegis Skills — Suggestion Deduplication, Admin Review & Dynamic Skill Engine
 *
 * Public API for:
 *   - Phase 6: Suggestion Deduplication and Admin Review subsystem
 *   - Phase 8: Dynamic Skill Engine and Tooling
 *
 * Deduplication state machine:
 *   NEW → DUPLICATE_CHECK → {EXACT_DUPLICATE, PARTIAL_OVERLAP, UNIQUE}
 *     → MERGE_PROPOSAL → RESOLVED
 *   AWAITING_ADMIN → {APPROVED → STAGING, REJECTED → CLOSING}
 *
 * Skill engine:
 *   Discovers, parses, validates, registers, and executes
 *   YAML-frontmattered skill scripts with MCP tool access.
 */

// ── Phase 6: Deduplication & Review ────────────────────────────

export {
  SuggestionDeduplicator,
  suggestionDeduplicator,
  type DeduplicationResult,
} from './deduplicator.js';

export {
  ReviewFlowHandler,
  reviewFlowHandler,
  type EvaluationResult,
  type ApprovalResult,
  type RejectionResult,
} from './reviewer.js';

// ── Phase 8: Skill Engine ─────────────────────────────────────

export {
  SkillEngine,
  skillEngine,
  type SkillFile,
} from './skillEngine.js';

export {
  runSkillScript,
  runSkillInSandbox,
  runSkillWithMetadata,
  SkillExecutionError,
  type SkillContext,
  type SkillRunResult,
} from './skillRunner.js';
