/**
 * Crash Report Detection Tests — Vanguard Detection Layer
 *
 * Pure-logic tests for the crash-signature detector: paste links
 * (mclogs/pastebin/bytebin/...), inline crash report markers, and
 * the type classification between paste_link and inline_crash.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectCrashReport } from '../detection/crashDetector.js';

describe('detectCrashReport', () => {
  it('should detect mclo.gs paste links', () => {
    const result = detectCrashReport('server crashed, log: https://mclo.gs/AbC12345 please help');
    assert.equal(result.detected, true);
    assert.equal(result.type, 'paste_link');
    assert.ok(result.matches.some((m) => m.includes('mclo.gs')));
  });

  it('should detect pastebin links', () => {
    const result = detectCrashReport('https://pastebin.com/raw/xYZ98765');
    assert.equal(result.detected, true);
    assert.equal(result.type, 'paste_link');
  });

  it('should detect mclogs.io links case-insensitively', () => {
    const result = detectCrashReport('HTTPS://MCLOGS.IO/LOG/xyz');
    assert.equal(result.detected, true);
    assert.equal(result.type, 'paste_link');
  });

  it('should detect bytebin links', () => {
    const result = detectCrashReport('https://bytebin.lucko.me/someId');
    assert.equal(result.detected, true);
    assert.equal(result.type, 'paste_link');
  });

  it('should detect inline Minecraft crash report headers', () => {
    const log = '---- Minecraft Crash Report ----\n// I let you down. Sorry :(\nDescription: Exception ticking world';
    const result = detectCrashReport(log);
    assert.equal(result.detected, true);
    assert.equal(result.type, 'inline_crash');
    assert.ok(result.matches.length >= 2);
  });

  it('should detect inline JVM error signatures', () => {
    const result = detectCrashReport('java.lang.OutOfMemoryError: Java heap space');
    assert.equal(result.detected, true);
    assert.equal(result.type, 'inline_crash');
  });

  it('should detect modlauncher classloader signatures', () => {
    const result = detectCrashReport('at cpw.mods.modlauncher.LaunchingClassLoader.loadClass');
    assert.equal(result.detected, true);
    assert.equal(result.type, 'inline_crash');
  });

  it('should not flag ordinary messages', () => {
    assert.equal(detectCrashReport('anyone online?').detected, false);
    assert.equal(detectCrashReport('my server is laggy today').detected, false);
    assert.equal(detectCrashReport('').detected, false);
  });

  it('should classify paste_link when both link and inline text are present', () => {
    const content = '---- Minecraft Crash Report ---- see https://mclo.gs/AbC12345';
    const result = detectCrashReport(content);
    assert.equal(result.detected, true);
    assert.equal(result.type, 'paste_link');
  });

  it('should prefer paste_link type when any URL match exists among several', () => {
    const content = 'check https://pastebin.com/aaa and https://gnome.dev/paste/bbb';
    const result = detectCrashReport(content);
    assert.equal(result.type, 'paste_link');
    assert.ok(result.matches.length >= 2);
  });
});
