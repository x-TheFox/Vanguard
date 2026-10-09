/**
 * Crash Report Parser Tests
 *
 * Tests parsing of Minecraft crash reports: full reports,
 * OOM crashes, mod conflicts, version mismatches, and
 * malformed/empty input.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCrashReport } from '../diagnostics/crashParser.js';

// ── Test Data ───────────────────────────────────────────────────

const FULL_CRASH_REPORT = `---- Minecraft Crash Report ----
// You should try our sister game, Minceraft!

Time: 2024-06-15 10:23:45
Description: Ticking entity

java.lang.NullPointerException: Cannot invoke "net.minecraft.world.entity.Entity.getLevel()" because "entity" is null
   at net.minecraft.server.level.ServerLevel.tickNonPassenger(ServerLevel.java:678)
   at net.minecraft.server.level.ServerLevel.tick(ServerLevel.java:543)
   at net.minecraft.server.MinecraftServer.tickChildren(MinecraftServer.java:1234)
   at net.minecraft.server.MinecraftServer.tickServer(MinecraftServer.java:1100)
   at net.minecraft.server.MinecraftServer.runServer(MinecraftServer.java:876)
   at net.minecraft.server.MinecraftServer.lambda$spin$0(MinecraftServer.java:234)

A detailed walkthrough of the error:
   at com.example.mymod.MyModEntity.tick(MyModEntity.java:45)
   at net.minecraftforge.fml.common.Loader.loadMod(Loader.java:123)

-- System Details --
Details:
   Minecraft Version: 1.20.4
   Java Version: 17.0.9 (Eclipse Adoptium)
   JVM Flags: 9 total; -Xmx4G
   Mod ID: mymod
   Mod ID: othermod
`;

const OOM_CRASH_REPORT = `---- Minecraft Crash Report ----
Time: 2024-06-15 11:00:00
Description: Exception in server tick loop

java.lang.OutOfMemoryError: Java heap space
   at net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:500)
   at net.minecraft.server.MinecraftServer.runServer(MinecraftServer.java:400)

-- System Details --
Minecraft Version: 1.20.4
Java Version: 17.0.9
JVM Flags: 3 total; -Xmx2G
`;

const MOD_CONFLICT_REPORT = `---- Minecraft Crash Report ----
Description: Mod loading error

java.lang.IllegalStateException: Mod resolution failed
   at net.minecraftforge.fml.common.Loader.loadMod(Loader.java:100)

Caused by: java.lang.RuntimeException: Duplicate mod: create
   at net.minecraftforge.fml.ModContainer.<init>(ModContainer.java:50)

Mod 'create' failed to load due to duplicate
Mod ID: create
Mod ID: flywheel
`;

const VERSION_MISMATCH_REPORT = `---- Minecraft Crash Report ----
Description: Rendering block entity

java.lang.NoSuchMethodError: 'void net.minecraft.world.level.block.entity.BlockEntity.<init>(net.minecraft.world.level.block.state.BlockState)'
   at com.example.compatmod.CompatBlockEntity.<init>(CompatBlockEntity.java:30)

-- System Details --
Minecraft Version: 1.20.1
Java Version: 17.0.8
`;

const CONFIG_ERROR_REPORT = `---- Minecraft Crash Report ----
Description: Loading config

com.google.gson.JsonSyntaxException: Expected BEGIN_OBJECT but was STRING
   at com.example.configmod.ConfigLoader.load(ConfigLoader.java:20)
Failed to load config for mod: configmod
`;

const MINIMAL_REPORT = `java.lang.NullPointerException: Something went wrong
   at net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:500)`;

// ── Tests ───────────────────────────────────────────────────────

describe('parseCrashReport — full report', () => {
  it('should parse crash type from Description line', () => {
    const result = parseCrashReport(FULL_CRASH_REPORT);
    assert.strictEqual(result.crashType, 'Ticking entity');
  });

  it('should extract root exception class', () => {
    const result = parseCrashReport(FULL_CRASH_REPORT);
    assert.strictEqual(result.rootException, 'java.lang.NullPointerException');
  });

  it('should extract root message', () => {
    const result = parseCrashReport(FULL_CRASH_REPORT);
    assert.ok(result.rootMessage.includes('Cannot invoke'));
  });

  it('should extract stack trace frames', () => {
    const result = parseCrashReport(FULL_CRASH_REPORT);
    assert.ok(result.stackTrace.length > 0);
    assert.ok(result.stackTrace.some((f) => f.includes('ServerLevel')));
  });

  it('should extract mod IDs', () => {
    const result = parseCrashReport(FULL_CRASH_REPORT);
    assert.ok(result.modIds.includes('mymod') || result.modIds.includes('othermod'));
  });

  it('should extract Java version', () => {
    const result = parseCrashReport(FULL_CRASH_REPORT);
    assert.ok(result.javaVersion?.includes('17.0.9'));
  });

  it('should extract Minecraft version', () => {
    const result = parseCrashReport(FULL_CRASH_REPORT);
    assert.strictEqual(result.minecraftVersion, '1.20.4');
  });

  it('should extract JVM memory', () => {
    const result = parseCrashReport(FULL_CRASH_REPORT);
    assert.strictEqual(result.jvmMemory, '4G');
  });

  it('should preserve raw content', () => {
    const result = parseCrashReport(FULL_CRASH_REPORT);
    assert.strictEqual(result.rawContent, FULL_CRASH_REPORT);
  });
});

describe('parseCrashReport — OOM crash', () => {
  it('should classify OOM crash as out_of_memory', () => {
    const result = parseCrashReport(OOM_CRASH_REPORT);
    assert.strictEqual(result.category, 'out_of_memory');
  });

  it('should extract OutOfMemoryError as root exception', () => {
    const result = parseCrashReport(OOM_CRASH_REPORT);
    assert.strictEqual(result.rootException, 'java.lang.OutOfMemoryError');
  });

  it('should report small heap size', () => {
    const result = parseCrashReport(OOM_CRASH_REPORT);
    assert.strictEqual(result.jvmMemory, '2G');
  });
});

describe('parseCrashReport — mod conflict', () => {
  it('should classify mod conflict', () => {
    const result = parseCrashReport(MOD_CONFLICT_REPORT);
    assert.strictEqual(result.category, 'mod_conflict');
  });

  it('should extract mod IDs from conflict', () => {
    const result = parseCrashReport(MOD_CONFLICT_REPORT);
    assert.ok(result.modIds.includes('create') || result.modIds.includes('flywheel'));
  });
});

describe('parseCrashReport — version mismatch', () => {
  it('should classify version mismatch', () => {
    const result = parseCrashReport(VERSION_MISMATCH_REPORT);
    assert.strictEqual(result.category, 'version_mismatch');
  });

  it('should extract NoSuchMethodError as root exception', () => {
    const result = parseCrashReport(VERSION_MISMATCH_REPORT);
    assert.strictEqual(result.rootException, 'java.lang.NoSuchMethodError');
  });
});

describe('parseCrashReport — config error', () => {
  it('should classify config error', () => {
    const result = parseCrashReport(CONFIG_ERROR_REPORT);
    assert.strictEqual(result.category, 'config_error');
  });
});

describe('parseCrashReport — minimal/malformed input', () => {
  it('should handle minimal crash report (no Description line)', () => {
    const result = parseCrashReport(MINIMAL_REPORT);
    assert.strictEqual(result.rootException, 'java.lang.NullPointerException');
    assert.ok(result.stackTrace.length > 0);
  });

  it('should handle empty input', () => {
    const result = parseCrashReport('');
    assert.strictEqual(result.rootException, 'UnknownException');
    assert.strictEqual(result.rootMessage, '');
    assert.strictEqual(result.category, 'unknown');
    assert.strictEqual(result.stackTrace.length, 0);
  });

  it('should handle garbage input', () => {
    const result = parseCrashReport('not a crash report just random text here');
    assert.strictEqual(result.category, 'unknown');
    assert.strictEqual(result.javaVersion, null);
    assert.strictEqual(result.minecraftVersion, null);
  });
});
