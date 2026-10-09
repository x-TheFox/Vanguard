/**
 * Crash Report Parser — Aegis Diagnostics
 *
 * Parses Minecraft crash reports into structured data suitable for
 * automated diagnosis. Supports Forge, Fabric, and NeoForge crash
 * report formats.
 *
 * Lifecycle: PARSING_LOG state (Section A of 03_state_machines.md)
 */

// ── Types ──────────────────────────────────────────────────────

export interface ParsedCrashReport {
  crashType: string;
  rootException: string;
  rootMessage: string;
  stackTrace: string[];
  modIds: string[];
  javaVersion: string | null;
  minecraftVersion: string | null;
  jvmMemory: string | null;
  category: 'mod_conflict' | 'out_of_memory' | 'version_mismatch' | 'config_error' | 'unknown';
  rawContent: string;
}

// ── Regex Patterns ─────────────────────────────────────────────

/** Matches the "Description:" line in a Minecraft crash report */
const DESCRIPTION_PATTERN = /^Description:\s*(.+)$/m;

/** Matches the root exception class and message, e.g. "java.lang.NullPointerException: Thing" */
const EXCEPTION_PATTERN = /^([a-zA-Z][a-zA-Z0-9._$]*(?:Exception|Error|Failure|Fault)):\s*(.+)$/m;

/** Matches stack-trace frames like "	at net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:123)" */
const STACK_FRAME_PATTERN = /^\s+at\s+(.+)$/gm;

/** Matches "Caused by" secondary exceptions */
const CAUSED_BY_PATTERN = /Caused by:\s*([a-zA-Z][a-zA-Z0-9._$]*(?:Exception|Error|Failure|Fault)):\s*(.+)$/m;

/** Matches Forge mod-loading stack frames like "	at net.minecraftforge.fml.common.Loader.loadMod(Loader.java:123)" */
const FORGE_MOD_FRAME_PATTERN = /(?:forge|fml|neoforge)\.(?:fml|loading|common)\..*$/m;

/** Matches Fabric mod-loading stack frames */
const FABRIC_MOD_FRAME_PATTERN = /net\.fabric(?:mc|loader)\./m;

/** Matches mod IDs inside stack frames or details — Forge style: modid */
const MOD_ID_FORGE_PATTERN = /(?:Loading|Mod)\s+(?:ID|id):\s*([a-z][a-z0-9_-]{1,63})/g;

/** Matches mod IDs inside stack frames — Fabric style: mod-id */
const MOD_ID_FABRIC_PATTERN = /Mod\s+['"]([a-z][a-z0-9_-]{1,63})['"]\s+failed/gi;

/** Matches mod IDs in "A detailed walkthrough of the error" Forge section */
const MOD_LIST_FORGE_PATTERN = /(?:\w+)\s*\|\s*([a-z][a-z0-9_-]{1,63})\s*\|\s*/g;

/** Matches Java version from crash reports */
const JAVA_VERSION_PATTERN = /Java Version:\s*(.+?)(?:\n|$)/m;

/** Matches "Java Version" alternate format */
const JAVA_VERSION_ALT_PATTERN = /Running\s+(?:on\s+)?(?:Java\s+)?([\d._]+(?:-[a-zA-Z0-9]+)?)/m;

/** Matches Minecraft version */
const MC_VERSION_PATTERN = /Minecraft Version:\s*(.+?)(?:\n|$)/m;

/** Matches Minecraft version alternate format */
const MC_VERSION_ALT_PATTERN = /(?:Minecraft|mc)\s+v?(\d+\.\d+(?:\.\d+)?)/im;

/** Matches JVM memory settings */
const JVM_MEMORY_PATTERN = /JVM Flags:\s*(\d+ total).*?-Xmx(\S+)/m;

/** Matches OOM indicators */
const OOM_PATTERN = /(?:OutOfMemoryError|out of memory|Could not reserve enough space)/im;

/** Matches version mismatch indicators */
const VERSION_MISMATCH_PATTERN =
  /(?:NoSuchMethodError|NoClassDefFoundError|ClassNotFoundException|IncompatibleClassChangeError|WrongMethodTypeError)/m;

/** Matches config-error indicators */
const CONFIG_ERROR_PATTERN =
  /(?:JsonSyntaxException|JsonParseException|MalformedJsonException|Invalid\s+config|config\s+error|Failed\s+to\s+load\s+config)/im;

/** Matches mod conflict indicators */
const MOD_CONFLICT_PATTERN =
  /(?:Duplicate\s+mod|Mod\s+resolution\s+failed|Found\s+duplicate|incompatible\s+mod|mod\s+conflict|Failed\s+to\s+load\s+mod|Unable\s+to\s+load\s+mod)/im;

/** Maximum number of stack frames to extract */
const MAX_STACK_FRAMES = 20;

// ── Parser Implementation ──────────────────────────────────────

/**
 * Parse a raw Minecraft crash report into structured data.
 *
 * Supports standard Forge/Fabric crash report format with
 * "Description:", stack trace, and system details sections.
 */
export function parseCrashReport(content: string): ParsedCrashReport {
  const crashType = extractCrashType(content);
  const { rootException, rootMessage } = extractRootException(content);
  const stackTrace = extractStackTrace(content);
  const modIds = extractModIds(content, stackTrace);
  const javaVersion = extractJavaVersion(content);
  const minecraftVersion = extractMinecraftVersion(content);
  const jvmMemory = extractJvmMemory(content);
  const category = classifyCrash(content, rootException);

  return {
    crashType,
    rootException,
    rootMessage,
    stackTrace,
    modIds,
    javaVersion,
    minecraftVersion,
    jvmMemory,
    category,
    rawContent: content,
  };
}

// ── Extraction Helpers ─────────────────────────────────────────

/** Extract the crash type from the "Description:" line */
function extractCrashType(content: string): string {
  const match = DESCRIPTION_PATTERN.exec(content);
  if (match && match[1]) {
    return match[1].trim();
  }

  // Fallback: first line that looks like a description
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 10 && !trimmed.startsWith('//') && !trimmed.startsWith('/*')) {
      return trimmed.substring(0, 120);
    }
  }

  return 'Unknown crash type';
}

/** Extract the root exception class and message */
function extractRootException(content: string): { rootException: string; rootMessage: string } {
  // Try primary exception pattern first
  const primaryMatch = EXCEPTION_PATTERN.exec(content);
  if (primaryMatch) {
    return {
      rootException: primaryMatch[1] ?? 'UnknownException',
      rootMessage: primaryMatch[2] ?? '',
    };
  }

  // Try "Caused by" as secondary
  const causedByMatch = CAUSED_BY_PATTERN.exec(content);
  if (causedByMatch) {
    return {
      rootException: causedByMatch[1] ?? 'UnknownException',
      rootMessage: causedByMatch[2] ?? '',
    };
  }

  // Fallback: look for any Java throwable class
  const throwablePattern = /^([a-zA-Z][a-zA-Z0-9._$]*Exception|Error):?\s*(.*)$/m;
  const throwableMatch = throwablePattern.exec(content);
  if (throwableMatch) {
    return {
      rootException: throwableMatch[1] ?? 'UnknownException',
      rootMessage: throwableMatch[2]?.trim() ?? '',
    };
  }

  return {
    rootException: 'UnknownException',
    rootMessage: '',
  };
}

/** Extract the top N stack trace frames */
function extractStackTrace(content: string): string[] {
  const frames: string[] = [];
  let match: RegExpExecArray | null;

  // Reset the regex state
  const regex = new RegExp(STACK_FRAME_PATTERN.source, 'gm');

  while ((match = regex.exec(content)) !== null) {
    if (match[1]) {
      frames.push(match[1].trim());
    }
    if (frames.length >= MAX_STACK_FRAMES) {
      break;
    }
  }

  return frames;
}

/** Extract mod IDs from the report content and stack frames */
function extractModIds(content: string, stackTrace: string[]): string[] {
  const modIdSet = new Set<string>();

  // Extract from Forge-style "Loading ID:" lines
  let match: RegExpExecArray | null;
  const forgeModPattern = new RegExp(MOD_ID_FORGE_PATTERN.source, 'gi');
  while ((match = forgeModPattern.exec(content)) !== null) {
    if (match[1]) modIdSet.add(match[1]);
  }

  // Extract from Fabric-style "Mod 'modid' failed" lines
  const fabricModPattern = new RegExp(MOD_ID_FABRIC_PATTERN.source, 'gi');
  while ((match = fabricModPattern.exec(content)) !== null) {
    if (match[1]) modIdSet.add(match[1]);
  }

  // Extract from mod list tables in Forge crash reports
  const modListPattern = new RegExp(MOD_LIST_FORGE_PATTERN.source, 'gi');
  while ((match = modListPattern.exec(content)) !== null) {
    if (match[1]) modIdSet.add(match[1]);
  }

  // Extract mod IDs from stack trace frames
  for (const frame of stackTrace) {
    // Look for mod-specific package patterns like "com.example.modid" or "io.github.modid"
    const modPackageMatch = /(?:com|io|net|org)\.[a-z0-9]+\.[a-z0-9_]+/i.exec(frame);
    if (modPackageMatch) {
      // The last segment of the package is often the mod ID
      const segments = modPackageMatch[0]!.split('.');
      const lastSegment = segments[segments.length - 1];
      if (lastSegment && lastSegment.length >= 2 && lastSegment.length <= 63) {
        modIdSet.add(lastSegment);
      }
    }

    // Also check for Forge/Fabric mod loading frames
    if (FORGE_MOD_FRAME_PATTERN.test(frame) || FABRIC_MOD_FRAME_PATTERN.test(frame)) {
      // The frame itself indicates a mod-loading context —
      // try to capture the mod ID from the surrounding context
      const modRefMatch = /["']([a-z][a-z0-9_-]{1,63})["']/i.exec(frame);
      if (modRefMatch && modRefMatch[1]) {
        modIdSet.add(modRefMatch[1]);
      }
    }
  }

  // Look for explicit mod listings in the crash report
  // Forge format: "		modid	|	Mod Name	|	version"
  const modTablePattern = /^\s*([a-z][a-z0-9_-]{1,63})\s*\|/gm;
  while ((match = modTablePattern.exec(content)) !== null) {
    if (match[1]) modIdSet.add(match[1]);
  }

  return [...modIdSet];
}

/** Extract Java version from the crash report */
function extractJavaVersion(content: string): string | null {
  const match = JAVA_VERSION_PATTERN.exec(content);
  if (match && match[1]) {
    return match[1].trim();
  }

  const altMatch = JAVA_VERSION_ALT_PATTERN.exec(content);
  if (altMatch && altMatch[1]) {
    return altMatch[1].trim();
  }

  return null;
}

/** Extract Minecraft version from the crash report */
function extractMinecraftVersion(content: string): string | null {
  const match = MC_VERSION_PATTERN.exec(content);
  if (match && match[1]) {
    return match[1].trim();
  }

  const altMatch = MC_VERSION_ALT_PATTERN.exec(content);
  if (altMatch && altMatch[1]) {
    return altMatch[1].trim();
  }

  return null;
}

/** Extract JVM memory settings */
function extractJvmMemory(content: string): string | null {
  const match = JVM_MEMORY_PATTERN.exec(content);
  if (match && match[2]) {
    return match[2].trim();
  }

  return null;
}

/** Classify the crash into a diagnostic category */
function classifyCrash(
  content: string,
  rootException: string,
): ParsedCrashReport['category'] {
  // Check OOM first — most critical
  if (OOM_PATTERN.test(content) || rootException.includes('OutOfMemoryError')) {
    return 'out_of_memory';
  }

  // Check version mismatch — common with mod incompatibilities
  if (VERSION_MISMATCH_PATTERN.test(content) || rootException.includes('NoSuchMethodError') ||
      rootException.includes('NoClassDefFoundError') || rootException.includes('ClassNotFoundException')) {
    return 'version_mismatch';
  }

  // Check config errors
  if (CONFIG_ERROR_PATTERN.test(content)) {
    return 'config_error';
  }

  // Check mod conflicts
  if (MOD_CONFLICT_PATTERN.test(content)) {
    return 'mod_conflict';
  }

  return 'unknown';
}
