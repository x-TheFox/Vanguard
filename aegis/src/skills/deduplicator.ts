/**
 * Suggestion Deduplication Engine — Aegis
 *
 * Implements the Partial Overlap Deduplication Lifecycle from
 * Section B of 03_state_machines.md.
 *
 * State machine:
 *   NEW → DUPLICATE_CHECK → {EXACT_DUPLICATE, PARTIAL_OVERLAP, UNIQUE}
 *     → MERGE_PROPOSAL → RESOLVED
 *
 * Checks new suggestions against existing ones in the suggestion_threads
 * table:
 *   - Exact match: same mod ID and version → mark as duplicate, auto-archive
 *   - Partial overlap: same mod, different version, or overlapping
 *     functionality → create merge proposal
 *   - Unique: no match → proceed to evaluation
 */

import { db } from '../db/client.js';
import { suggestionThreads } from '../db/schema.js';
import { eq, and, ne, inArray } from 'drizzle-orm';

// ── Types ──────────────────────────────────────────────────────

export interface DeduplicationResult {
  threadId: string;
  status: 'exact_duplicate' | 'partial_overlap' | 'unique';
  duplicateOf?: string; // Thread ID of the existing suggestion
  overlapScore?: number; // 0.0 - 1.0 for partial matches
  mergeProposal?: {
    threadId: string; // New thread to merge into
    mergedFrom: string; // This thread
    reason: string;
  };
}

interface ModIdentifier {
  curseforgeId?: string;
  modrinthId?: string;
  slug?: string;
  name: string;
  version?: string;
  status?: 'pending' | 'duplicate' | 'unique';
  duplicateOfThreadId?: string | null;
}

interface PotentialDuplicate {
  threadId: string;
  title: string;
  overlapScore: number;
  modIdentifiers?: ModIdentifier[];
}

// ── Deduplication Thresholds ───────────────────────────────────

const OVERLAP_THRESHOLD_PARTIAL = 0.4;
const OVERLAP_THRESHOLD_EXACT = 0.95;

// ── Suggestion Deduplicator ────────────────────────────────────

export class SuggestionDeduplicator {
  /**
   * Check a new suggestion against existing ones.
   *
   * Implements the DUPLICATE_CHECK state: queries all active suggestion
   * threads (status = 'review' | 'staged') and compares mod identifiers
   * for exact and partial overlap.
   */
  async check(
    threadId: string,
    title: string,
    description: string,
  ): Promise<DeduplicationResult> {
    // Find potential duplicates among active suggestion threads
    const candidates = await this.findPotentialDuplicates(title, description);

    if (candidates.length === 0) {
      return { threadId, status: 'unique' };
    }

    // Rank by overlap score (highest first)
    candidates.sort((a, b) => b.overlapScore - a.overlapScore);
    const bestMatch = candidates[0]!;

    if (bestMatch.overlapScore >= OVERLAP_THRESHOLD_EXACT) {
      // Exact duplicate — same mod ID and version
      return {
        threadId,
        status: 'exact_duplicate',
        duplicateOf: bestMatch.threadId,
        overlapScore: bestMatch.overlapScore,
      };
    }

    if (bestMatch.overlapScore >= OVERLAP_THRESHOLD_PARTIAL) {
      // Partial overlap — same mod, different version, or overlapping
      // functionality → create merge proposal
      return {
        threadId,
        status: 'partial_overlap',
        duplicateOf: bestMatch.threadId,
        overlapScore: bestMatch.overlapScore,
        mergeProposal: {
          threadId: bestMatch.threadId,
          mergedFrom: threadId,
          reason: this.buildMergeReason(bestMatch, title),
        },
      };
    }

    // Below threshold — treat as unique
    return { threadId, status: 'unique' };
  }

  /**
   * Check resolved mod identifiers against existing active suggestion
   * threads and the active server mod list. This is the CHECKING_OVERLAPS
   * transition from the state machine.
   *
   * @param threadId    - The current suggestion thread
   * @param resolvedMods - Mod identifiers extracted from the suggestion
   * @returns Updated mods with status + exclusion list entries
   */
  async checkModOverlaps(
    threadId: string,
    resolvedMods: ModIdentifier[],
  ): Promise<{
    updatedMods: ModIdentifier[];
    exclusionList: Array<{
      slug: string;
      reason: string;
      referenceThreadId: string | null;
    }>;
    allDuplicates: boolean;
    anyDuplicates: boolean;
  }> {
    const exclusionList: Array<{
      slug: string;
      reason: string;
      referenceThreadId: string | null;
    }> = [];

    // Fetch active suggestions (review or staged), excluding current thread
    const activeSuggestions = await db
      .select({
        threadId: suggestionThreads.threadId,
        modIdentifiers: suggestionThreads.modIdentifiers,
      })
      .from(suggestionThreads)
      .where(
        and(
          inArray(suggestionThreads.status, ['review', 'staged']),
          ne(suggestionThreads.threadId, threadId),
        ),
      );

    // Build lookup of existing mods across all active suggestions
    const existingModMap = new Map<
      string,
      { threadId: string; slug: string; name: string }
    >();
    for (const suggestion of activeSuggestions) {
      const mods = (suggestion.modIdentifiers ?? []) as ModIdentifier[];
      for (const mod of mods) {
        if (mod.curseforgeId) {
          existingModMap.set(`cf:${mod.curseforgeId}`, {
            threadId: suggestion.threadId,
            slug: mod.slug ?? mod.name,
            name: mod.name,
          });
        }
        if (mod.modrinthId) {
          existingModMap.set(`mr:${mod.modrinthId}`, {
            threadId: suggestion.threadId,
            slug: mod.slug ?? mod.name,
            name: mod.name,
          });
        }
        if (mod.slug) {
          existingModMap.set(`slug:${mod.slug}`, {
            threadId: suggestion.threadId,
            slug: mod.slug,
            name: mod.name,
          });
        }
      }
    }

    // Check each resolved mod against existing suggestions
    for (const mod of resolvedMods) {
      let isDuplicate = false;

      // Check by curseforge_id
      if (mod.curseforgeId && existingModMap.has(`cf:${mod.curseforgeId}`)) {
        const existing = existingModMap.get(`cf:${mod.curseforgeId}`)!;
        mod.status = 'duplicate';
        mod.duplicateOfThreadId = existing.threadId;
        exclusionList.push({
          slug: mod.slug ?? mod.name,
          reason: 'Already under review in another thread',
          referenceThreadId: existing.threadId,
        });
        isDuplicate = true;
      }

      // Check by modrinth_id
      if (
        !isDuplicate &&
        mod.modrinthId &&
        existingModMap.has(`mr:${mod.modrinthId}`)
      ) {
        const existing = existingModMap.get(`mr:${mod.modrinthId}`)!;
        mod.status = 'duplicate';
        mod.duplicateOfThreadId = existing.threadId;
        exclusionList.push({
          slug: mod.slug ?? mod.name,
          reason: 'Already under review in another thread',
          referenceThreadId: existing.threadId,
        });
        isDuplicate = true;
      }

      // Check by slug
      if (
        !isDuplicate &&
        mod.slug &&
        existingModMap.has(`slug:${mod.slug}`)
      ) {
        const existing = existingModMap.get(`slug:${mod.slug}`)!;
        mod.status = 'duplicate';
        mod.duplicateOfThreadId = existing.threadId;
        exclusionList.push({
          slug: mod.slug,
          reason: 'Already under review in another thread',
          referenceThreadId: existing.threadId,
        });
        isDuplicate = true;
      }

      if (!isDuplicate) {
        mod.status = 'unique';
      }
    }

    const allDuplicates = resolvedMods.every((m) => m.status === 'duplicate');
    const anyDuplicates = resolvedMods.some((m) => m.status === 'duplicate');

    return { updatedMods: resolvedMods, exclusionList, allDuplicates, anyDuplicates };
  }

  /**
   * Archive a thread that is a full duplicate (all mods already exist).
   * Implements the FULL_DUPLICATE → ARCHIVING → CLOSED transition.
   */
  async archiveDuplicate(
    threadId: string,
    exclusionList: Array<{
      slug: string;
      reason: string;
      referenceThreadId: string | null;
    }>,
  ): Promise<void> {
    await db
      .update(suggestionThreads)
      .set({
        status: 'archived',
        exclusionList: exclusionList as unknown as Record<string, unknown>[],
        updatedAt: new Date(),
      })
      .where(eq(suggestionThreads.threadId, threadId));
  }

  /**
   * Update a thread with partial overlap data, keeping it in review
   * but recording excluded duplicates. Implements the PARTIAL_OVERLAP
   * → EXCLUDING_DUPES → EVALUATING_UNIQUE transition.
   */
  async recordPartialOverlap(
    threadId: string,
    updatedMods: ModIdentifier[],
    exclusionList: Array<{
      slug: string;
      reason: string;
      referenceThreadId: string | null;
    }>,
  ): Promise<void> {
    await db
      .update(suggestionThreads)
      .set({
        modIdentifiers: updatedMods as unknown as Record<string, unknown>[],
        exclusionList: exclusionList as unknown as Record<string, unknown>[],
        updatedAt: new Date(),
      })
      .where(eq(suggestionThreads.threadId, threadId));
  }

  /**
   * Find potential duplicates for a suggestion by comparing title and
   * description text against all active suggestion threads.
   */
  private async findPotentialDuplicates(
    title: string,
    description: string,
  ): Promise<PotentialDuplicate[]> {
    // Fetch all active suggestion threads
    const activeThreads = await db
      .select({
        threadId: suggestionThreads.threadId,
        rawSuggestionText: suggestionThreads.rawSuggestionText,
        modIdentifiers: suggestionThreads.modIdentifiers,
      })
      .from(suggestionThreads)
      .where(inArray(suggestionThreads.status, ['review', 'staged']));

    const candidates: PotentialDuplicate[] = [];

    for (const thread of activeThreads) {
      const mods = (thread.modIdentifiers ?? []) as ModIdentifier[];
      const existingTitle = mods.map((m) => m.name).join(', ');
      const existingDesc = thread.rawSuggestionText;

      const overlapScore = this.calculateOverlap(
        title,
        description,
        existingTitle,
        existingDesc,
      );

      if (overlapScore >= OVERLAP_THRESHOLD_PARTIAL) {
        candidates.push({
          threadId: thread.threadId,
          title: existingTitle,
          overlapScore,
          modIdentifiers: mods,
        });
      }
    }

    return candidates;
  }

  /**
   * Calculate overlap score between two suggestions using
   * token-set similarity (Jaccard index on normalized word sets).
   *
   * Returns a value between 0.0 (no overlap) and 1.0 (identical).
   */
  private calculateOverlap(
    title1: string,
    desc1: string,
    title2: string,
    desc2: string,
  ): number {
    const tokenize = (text: string): Set<string> => {
      const normalized = text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2); // Skip very short tokens
      return new Set(normalized);
    };

    const set1 = tokenize(`${title1} ${desc1}`);
    const set2 = tokenize(`${title2} ${desc2}`);

    if (set1.size === 0 || set2.size === 0) return 0;

    // Jaccard index: |intersection| / |union|
    let intersectionSize = 0;
    for (const token of set1) {
      if (set2.has(token)) intersectionSize++;
    }

    const unionSize = set1.size + set2.size - intersectionSize;
    if (unionSize === 0) return 0;

    return intersectionSize / unionSize;
  }

  /**
   * Build a human-readable reason for a merge proposal.
   */
  private buildMergeReason(
    match: PotentialDuplicate,
    newTitle: string,
  ): string {
    const sharedMods: string[] = [];

    if (match.modIdentifiers) {
      for (const mod of match.modIdentifiers) {
        const modName = mod.name.toLowerCase();
        const newTitleLower = newTitle.toLowerCase();
        if (newTitleLower.includes(modName) || modName.includes(newTitleLower.split(' ')[0] ?? '')) {
          sharedMods.push(mod.name);
        }
      }
    }

    if (sharedMods.length > 0) {
      return `Overlapping mods detected: ${sharedMods.join(', ')}. Consider merging with existing thread.`;
    }

    return `Partial overlap (score: ${match.overlapScore.toFixed(2)}). Content similarity suggests this may be related to an existing suggestion.`;
  }
}

/** Singleton deduplicator instance */
export const suggestionDeduplicator = new SuggestionDeduplicator();
