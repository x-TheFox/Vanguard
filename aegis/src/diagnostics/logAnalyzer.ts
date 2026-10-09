/**
 * Server Log Analyzer — Aegis Diagnostics
 *
 * Analyzes Minecraft server.log content for patterns indicating problems:
 * error/warning frequency, repeating exceptions, mod loading failures,
 * memory pressure, and TPS degradation.
 *
 * Lifecycle: PARSING_LOG state (Section A of 03_state_machines.md)
 */

// ── Types ──────────────────────────────────────────────────────

export interface LogAnalysis {
  errorCount: number;
  warningCount: number;
  repeatingErrors: Array<{ pattern: string; count: number }>;
  modFailures: string[];
  memoryPressure: boolean;
  tpsDegradation: boolean;
  keyFindings: string[];
}

// ── Log Patterns ───────────────────────────────────────────────

/** Matches ERROR-level log lines */
const ERROR_LINE_PATTERN = /^\[.*\]\s*\[?(?:ERROR|SEVERE|FATAL)\]?/im;

/** Matches WARN-level log lines */
const WARN_LINE_PATTERN = /^\[.*\]\s*\[?(?:WARN|WARNING)\]?/im;

/** Matches exception class lines (stack trace headers) */
const EXCEPTION_HEADER_PATTERN = /^([a-zA-Z][a-zA-Z0-9._$]*(?:Exception|Error)):/gm;

/** Matches Forge/Fabric mod loading failure messages */
const MOD_FAILURE_PATTERN =
  /(?:Failed\s+to\s+load\s+mod|Mod\s+has\s+failed\s+to\s+load|Errored\s+mod:\s*|Failed\s+mod:\s*|Mod\s+['"]([a-z][a-z0-9_-]*)['"]?\s+(?:failed|errored|crashed))/gim;

/** Matches memory pressure indicators in server logs */
const MEMORY_PRESSURE_PATTERN =
  /(?:Running low on memory|Memory\s+(?:has|is)\s+exceeded|OutOfMemoryError|Failed\s+to\s+allocate|Can't allocate|memory\s+warning|GC\s+overhead|direct buffer memory)/im;

/** Matches specific TPS value extraction */
const TPS_VALUE_PATTERN = /TPS\s*(?:is|at|below|=\s*)\s*(\d+(?:\.\d+)?)/im;

/** Threshold for considering an error pattern as "repeating" */
const REPEAT_THRESHOLD = 3;

// ── Analyzer Implementation ────────────────────────────────────

/**
 * Analyze server.log content for problem indicators.
 *
 * Scans for error/warning counts, repeating exception patterns,
 * mod loading failures, memory pressure, and TPS degradation.
 */
export function analyzeServerLog(logContent: string): LogAnalysis {
  const lines = logContent.split('\n');

  const errorCount = countMatches(lines, ERROR_LINE_PATTERN);
  const warningCount = countMatches(lines, WARN_LINE_PATTERN);
  const repeatingErrors = findRepeatingErrors(logContent);
  const modFailures = findModFailures(logContent);
  const memoryPressure = detectMemoryPressure(logContent);
  const tpsDegradation = detectTpsDegradation(logContent);
  const keyFindings = synthesizeFindings(
    errorCount,
    warningCount,
    repeatingErrors,
    modFailures,
    memoryPressure,
    tpsDegradation,
    logContent,
  );

  return {
    errorCount,
    warningCount,
    repeatingErrors,
    modFailures,
    memoryPressure,
    tpsDegradation,
    keyFindings,
  };
}

// ── Analysis Helpers ───────────────────────────────────────────

/** Count how many lines match a given pattern */
function countMatches(lines: string[], pattern: RegExp): number {
  let count = 0;
  for (const line of lines) {
    if (pattern.test(line)) {
      count++;
    }
  }
  return count;
}

/** Find repeating exception patterns and their frequency */
function findRepeatingErrors(logContent: string): Array<{ pattern: string; count: number }> {
  const exceptionCounts = new Map<string, number>();

  let match: RegExpExecArray | null;
  const regex = new RegExp(EXCEPTION_HEADER_PATTERN.source, 'gm');

  while ((match = regex.exec(logContent)) !== null) {
    const exceptionClass = match[1];
    if (exceptionClass) {
      exceptionCounts.set(exceptionClass, (exceptionCounts.get(exceptionClass) ?? 0) + 1);
    }
  }

  const repeating: Array<{ pattern: string; count: number }> = [];
  for (const [pattern, count] of exceptionCounts) {
    if (count >= REPEAT_THRESHOLD) {
      repeating.push({ pattern, count });
    }
  }

  // Sort by count descending
  repeating.sort((a, b) => b.count - a.count);

  return repeating;
}

/** Extract mod IDs that failed to load */
function findModFailures(logContent: string): string[] {
  const failures = new Set<string>();

  let match: RegExpExecArray | null;
  const regex = new RegExp(MOD_FAILURE_PATTERN.source, 'gi');

  while ((match = regex.exec(logContent)) !== null) {
    // Capture group 1 is the mod ID, if the pattern matched it
    if (match[1]) {
      failures.add(match[1]);
    } else if (match[0]) {
      // Try to extract mod ID from the full match
      const idMatch = /['"]([a-z][a-z0-9_-]{1,63})['"]|(\b[a-z][a-z0-9_-]{1,63}\b)/i.exec(match[0]);
      if (idMatch) {
        const modId = idMatch[1] ?? idMatch[2];
        if (modId) failures.add(modId);
      }
    }
  }

  return [...failures];
}

/** Detect memory pressure indicators in the log */
function detectMemoryPressure(logContent: string): boolean {
  return MEMORY_PRESSURE_PATTERN.test(logContent);
}

/** Detect TPS (ticks per second) degradation */
function detectTpsDegradation(logContent: string): boolean {
  // Check for "Can't keep up!" or "Running N ticks behind" messages
  const cantKeepUp = /Can't keep up!|Running\s+\d+\s*ticks\s+behind/im;
  if (cantKeepUp.test(logContent)) {
    return true;
  }

  // Check for explicit low TPS values (below threshold)
  const tpsMatch = TPS_VALUE_PATTERN.exec(logContent);
  if (tpsMatch && tpsMatch[1]) {
    const tps = parseFloat(tpsMatch[1]);
    if (!isNaN(tps) && tps < 15) {
      return true;
    }
  }

  return false;
}

/** Synthesize key findings from the analysis */
function synthesizeFindings(
  errorCount: number,
  warningCount: number,
  repeatingErrors: Array<{ pattern: string; count: number }>,
  modFailures: string[],
  memoryPressure: boolean,
  tpsDegradation: boolean,
  _logContent: string,
): string[] {
  const findings: string[] = [];

  if (errorCount > 0) {
    findings.push(`${errorCount} ERROR-level log entries detected`);
  }

  if (warningCount > 10) {
    findings.push(`High warning count: ${warningCount} WARN entries`);
  }

  for (const { pattern, count } of repeatingErrors) {
    findings.push(`Repeating exception: ${pattern} (${count} occurrences)`);
  }

  for (const modId of modFailures) {
    findings.push(`Mod failed to load: ${modId}`);
  }

  if (memoryPressure) {
    findings.push('Memory pressure indicators detected — possible OOM or GC overhead');
  }

  if (tpsDegradation) {
    findings.push('TPS degradation detected — server struggling to keep up with tick rate');
  }

  if (findings.length === 0) {
    findings.push('No significant issues detected in server log');
  }

  return findings;
}
