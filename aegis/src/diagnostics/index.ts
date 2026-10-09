/**
 * Aegis Diagnostics — Crash Troubleshooting Subsystem
 *
 * Public API for the Phase 5 Crash Diagnostics subsystem.
 * Implements the Crash Log Troubleshooting Lifecycle from
 * Section A of 03_state_machines.md.
 *
 * State machine:
 *   IDLE → THREAD_CREATED → DIAGNOSING → {SEARCHING, PARSING_LOG}
 *     → ANALYZING → {ROOT_CAUSE, NEED_MORE_INFO} → {INTERACTING}
 *     → RESOLVED
 */

export { parseCrashReport, type ParsedCrashReport } from './crashParser.js';
export { analyzeServerLog, type LogAnalysis } from './logAnalyzer.js';
export { DiagnosticEngine, diagnosticEngine, type DiagnosticState, type DiagnosticResult } from './diagnosticEngine.js';
