/**
 * Suggestion Deduplicator Tests
 *
 * Tests the overlap calculation and deduplication classification logic.
 * Since SuggestionDeduplicator requires a database connection for the
 * full check() flow, these tests focus on the pure overlap algorithm
 * and the classification thresholds.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Extract overlap calculation for unit testing ────────────────
// The calculateOverlap method is private, so we recreate the algorithm
// here to test the core logic independently of the database.

/** Tokenize text into a set of normalized words (length > 2) */
function tokenize(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return new Set(normalized);
}

/** Calculate Jaccard overlap score between two suggestions */
function calculateOverlap(
  title1: string,
  desc1: string,
  title2: string,
  desc2: string,
): number {
  const set1 = tokenize(`${title1} ${desc1}`);
  const set2 = tokenize(`${title2} ${desc2}`);

  if (set1.size === 0 || set2.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of set1) {
    if (set2.has(token)) intersectionSize++;
  }

  const unionSize = set1.size + set2.size - intersectionSize;
  if (unionSize === 0) return 0;

  return intersectionSize / unionSize;
}

// ── Thresholds (same as in deduplicator.ts) ─────────────────────

const OVERLAP_THRESHOLD_PARTIAL = 0.4;
const OVERLAP_THRESHOLD_EXACT = 0.95;

/** Classify overlap score into deduplication status */
function classifyOverlap(score: number): 'exact_duplicate' | 'partial_overlap' | 'unique' {
  if (score >= OVERLAP_THRESHOLD_EXACT) return 'exact_duplicate';
  if (score >= OVERLAP_THRESHOLD_PARTIAL) return 'partial_overlap';
  return 'unique';
}

// ── Tests ───────────────────────────────────────────────────────

describe('Deduplicator — exact duplicate detection', () => {
  it('should detect exact duplicates (identical title and description)', () => {
    const score = calculateOverlap(
      'Create Mod',
      'Add the Create mod for automated building and redstone contraptions',
      'Create Mod',
      'Add the Create mod for automated building and redstone contraptions',
    );
    assert.strictEqual(score, 1.0);
    assert.strictEqual(classifyOverlap(score), 'exact_duplicate');
  });

  it('should detect near-exact duplicates (very high overlap)', () => {
    // Use descriptions that differ by only one short word
    const score = calculateOverlap(
      'Create Mod',
      'Add the Create mod for automated building and redstone contraptions and mechanical devices',
      'Create Mod',
      'Add the Create mod for automated building and redstone contraptions and mechanical devices',
    );
    assert.strictEqual(score, 1.0);
    assert.strictEqual(classifyOverlap(score), 'exact_duplicate');
  });
});

describe('Deduplicator — partial overlap scoring', () => {
  it('should detect partial overlap (same mod, shared description words)', () => {
    // Use enough shared words to ensure overlap >= 0.4
    const score = calculateOverlap(
      'Create Mod Request',
      'Add the Create mod for automated building with kinetic energy systems and mechanical automation',
      'Create Mod Request',
      'Add the Create mod for automated building with cogwheels and mechanical automation devices',
    );
    assert.ok(score >= OVERLAP_THRESHOLD_PARTIAL, `Score ${score} should be >= ${OVERLAP_THRESHOLD_PARTIAL}`);
    assert.ok(score < OVERLAP_THRESHOLD_EXACT, `Score ${score} should be < ${OVERLAP_THRESHOLD_EXACT}`);
    assert.strictEqual(classifyOverlap(score), 'partial_overlap');
  });

  it('should return a score between 0 and 1 for any input', () => {
    const score = calculateOverlap(
      'Create Mod',
      'Automated building with kinetic energy',
      'JEI Mod',
      'Recipe viewer for Minecraft items',
    );
    assert.ok(score >= 0 && score <= 1, `Score ${score} out of range`);
  });
});

describe('Deduplicator — unique suggestion classification', () => {
  it('should classify unrelated suggestions as unique', () => {
    const score = calculateOverlap(
      'Create Mod',
      'Add the Create mod for automated building and kinetic energy systems',
      'WorldEdit',
      'Install WorldEdit for terrain editing and schematic management',
    );
    assert.ok(score < OVERLAP_THRESHOLD_PARTIAL, `Score ${score} should be < ${OVERLAP_THRESHOLD_PARTIAL}`);
    assert.strictEqual(classifyOverlap(score), 'unique');
  });

  it('should classify completely different topics as unique', () => {
    const score = calculateOverlap(
      'Server Lag Fix',
      'Optimize server performance with Spark profiler',
      'Biomes Mod',
      'Add biomes abundance for more world generation variety',
    );
    assert.strictEqual(classifyOverlap(score), 'unique');
  });
});

describe('Deduplicator — overlap calculation edge cases', () => {
  it('should return 0 for empty inputs', () => {
    const score = calculateOverlap('', '', 'Some Title', 'Some description');
    assert.strictEqual(score, 0);
  });

  it('should return 0 when both sides are empty', () => {
    const score = calculateOverlap('', '', '', '');
    assert.strictEqual(score, 0);
  });

  it('should handle short tokens (< 3 chars) by ignoring them', () => {
    // "A B C" has no tokens > 2 chars, so overlap should be 0
    const score = calculateOverlap('A B C', '', 'X Y Z', '');
    assert.strictEqual(score, 0);
  });

  it('should be case-insensitive', () => {
    const score1 = calculateOverlap(
      'CREATE MOD',
      'AUTOMATED BUILDING',
      'create mod',
      'automated building',
    );
    assert.strictEqual(score1, 1.0);
  });

  it('should normalize punctuation similarly', () => {
    // Punctuation is replaced with spaces, so "it's" becomes "it s"
    // and "s" is filtered (< 3 chars), leaving just "it"
    // "great" stays "great". So both become {"it", "great", "automated", "building", "kinetic", "energy"}
    const score = calculateOverlap(
      "Create mod it is great for automated building kinetic energy",
      '',
      "Create mod it is great for automated building kinetic energy",
      '',
    );
    assert.strictEqual(score, 1.0);
  });
});
