/**
 * Server Log Analyzer Tests
 *
 * Tests error/warning counting, repeating pattern detection,
 * memory pressure, TPS degradation, and empty input handling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeServerLog } from '../diagnostics/logAnalyzer.js';

// ── Test Data ───────────────────────────────────────────────────
// Log format matches the regex patterns in logAnalyzer:
//   ERROR_LINE_PATTERN: ^\[.*\]\s*\[?(?:ERROR|SEVERE|FATAL)\]?
//   WARN_LINE_PATTERN:  ^\[.*\]\s*\[?(?:WARN|WARNING)\]?

const LOG_WITH_ERRORS = `[10:00:00] [INFO]: Starting minecraft server version 1.20.4
[10:00:01] [INFO]: Loading properties
[10:00:02] [ERROR]: Failed to load chunk at [0, 0]
[10:00:03] [WARN]: Can't keep up! Is the server overloaded?
[10:00:04] [ERROR]: Failed to load chunk at [1, 0]
[10:00:05] [WARN]: Memory has exceeded 90% of max
[10:00:06] [ERROR]: Failed to load chunk at [2, 0]
[10:00:07] [INFO]: Done (3.456s)!
[10:00:08] [ERROR]: Something else went wrong
`;

// Exception headers must appear at the START of a line for EXCEPTION_HEADER_PATTERN
const LOG_WITH_REPEATING_EXCEPTIONS = `[10:00:01] [ERROR]: Exception in server tick loop
java.lang.NullPointerException: entity is null
   at net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:500)
java.lang.NullPointerException: entity is null
   at net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:500)
java.lang.NullPointerException: entity is null
   at net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:500)
java.lang.IllegalStateException: bad state
   at com.example.mod.TickHandler.onTick(TickHandler.java:10)
java.lang.IllegalStateException: bad state
   at com.example.mod.TickHandler.onTick(TickHandler.java:10)
java.lang.IllegalStateException: bad state
   at com.example.mod.TickHandler.onTick(TickHandler.java:10)
`;

const LOG_WITH_MEMORY_PRESSURE = `[10:00:00] [WARN]: Running low on memory
[10:00:01] [ERROR]: java.lang.OutOfMemoryError: Java heap space
   at net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:500)
`;

const LOG_WITH_TPS_DEGRADATION = `[10:00:00] [WARN]: Can't keep up! Running 5000ms behind, skipping 100 tick(s)
[10:00:01] [INFO]: TPS is at 8.5
`;

const LOG_WITH_MOD_FAILURE = `[10:00:00] [ERROR]: Failed to load mod create
[10:00:01] [ERROR]: Mod 'flywheel' failed to load
[10:00:02] [ERROR]: Errored mod: create
`;

const CLEAN_LOG = `[10:00:00] [INFO]: Starting minecraft server version 1.20.4
[10:00:01] [INFO]: Loading properties
[10:00:02] [INFO]: Done (3.456s)!
[10:00:03] [INFO]: Joined player: Steve
`;

// ── Tests ───────────────────────────────────────────────────────

describe('analyzeServerLog — error and warning counts', () => {
  it('should count ERROR lines correctly', () => {
    const result = analyzeServerLog(LOG_WITH_ERRORS);
    assert.strictEqual(result.errorCount, 4);
  });

  it('should count WARN lines correctly', () => {
    const result = analyzeServerLog(LOG_WITH_ERRORS);
    assert.strictEqual(result.warningCount, 2);
  });

  it('should return zero counts for clean log', () => {
    const result = analyzeServerLog(CLEAN_LOG);
    assert.strictEqual(result.errorCount, 0);
    assert.strictEqual(result.warningCount, 0);
  });
});

describe('analyzeServerLog — repeating patterns', () => {
  it('should detect repeating exceptions (count >= 3)', () => {
    const result = analyzeServerLog(LOG_WITH_REPEATING_EXCEPTIONS);
    assert.ok(result.repeatingErrors.length >= 2);

    const npe = result.repeatingErrors.find((r) => r.pattern === 'java.lang.NullPointerException');
    assert.ok(npe, 'NullPointerException should be in repeating errors');
    assert.strictEqual(npe.count, 3);

    const ise = result.repeatingErrors.find((r) => r.pattern === 'java.lang.IllegalStateException');
    assert.ok(ise, 'IllegalStateException should be in repeating errors');
    assert.strictEqual(ise.count, 3);
  });

  it('should not report non-repeating exceptions', () => {
    const singleError = `java.lang.IllegalArgumentException: bad arg
   at com.example.mod.Handler.handle(Handler.java:10)`;
    const result = analyzeServerLog(singleError);
    // Only 1 occurrence — below threshold of 3
    assert.strictEqual(result.repeatingErrors.length, 0);
  });
});

describe('analyzeServerLog — memory pressure', () => {
  it('should detect memory pressure', () => {
    const result = analyzeServerLog(LOG_WITH_MEMORY_PRESSURE);
    assert.strictEqual(result.memoryPressure, true);
  });

  it('should not flag clean logs for memory pressure', () => {
    const result = analyzeServerLog(CLEAN_LOG);
    assert.strictEqual(result.memoryPressure, false);
  });
});

describe('analyzeServerLog — TPS degradation', () => {
  it('should detect TPS degradation via "Can\'t keep up!"', () => {
    const result = analyzeServerLog(LOG_WITH_TPS_DEGRADATION);
    assert.strictEqual(result.tpsDegradation, true);
  });

  it('should detect TPS degradation via explicit low TPS value', () => {
    const log = `[10:00:01] [INFO]: TPS at 8.5`;
    const result = analyzeServerLog(log);
    assert.strictEqual(result.tpsDegradation, true);
  });

  it('should not flag normal TPS as degradation', () => {
    const log = `[10:00:01] [INFO]: TPS at 19.8`;
    const result = analyzeServerLog(log);
    assert.strictEqual(result.tpsDegradation, false);
  });
});

describe('analyzeServerLog — mod failures', () => {
  it('should detect failed mods', () => {
    const result = analyzeServerLog(LOG_WITH_MOD_FAILURE);
    assert.ok(result.modFailures.length > 0);
  });
});

describe('analyzeServerLog — key findings', () => {
  it('should synthesize findings from analysis', () => {
    const result = analyzeServerLog(LOG_WITH_ERRORS);
    assert.ok(result.keyFindings.length > 0);
    // Should mention error count
    assert.ok(result.keyFindings.some((f) => f.includes('ERROR')));
  });

  it('should report "No significant issues" for clean logs', () => {
    const result = analyzeServerLog(CLEAN_LOG);
    assert.ok(result.keyFindings.some((f) => f.includes('No significant issues')));
  });
});

describe('analyzeServerLog — empty input', () => {
  it('should handle empty log content', () => {
    const result = analyzeServerLog('');
    assert.strictEqual(result.errorCount, 0);
    assert.strictEqual(result.warningCount, 0);
    assert.strictEqual(result.repeatingErrors.length, 0);
    assert.strictEqual(result.modFailures.length, 0);
    assert.strictEqual(result.memoryPressure, false);
    assert.strictEqual(result.tpsDegradation, false);
  });
});
