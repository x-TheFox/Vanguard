/**
 * Crash Report Detection — Vanguard Detection Layer
 *
 * Scans Discord messages for Minecraft crash report signatures,
 * including paste service links and inline crash report text.
 * Vanguard detects and delegates; Aegis diagnoses.
 */

/** Patterns that indicate a Minecraft crash report */
const CRASH_PATTERNS = [
  // Paste links
  /https?:\/\/mclo\.gs\/\S+/i,
  /https?:\/\/mclogs\.io\/\S+/i,
  /https?:\/\/pastebin\.com\/\S+/i,
  /https?:\/\/pastes\.io\/\S+/i,
  /https?:\/\/gnome\.dev\/paste\/\S+/i,
  /https?:\/\/bytebin\.lucko\.me\/\S+/i,
  // Direct crash signatures in message
  /---- Minecraft Crash Report ----/,
  /Description: (Exception ticking world|Unexpected error|Ticking entity|Rendering Block Entity|Server shutdown)/,
  /java\.lang\.(OutOfMemoryError|StackOverflowError|NoClassDefFoundError|NullPointerException)/,
  /cpw\.mods\.modlauncher\.LaunchingClassLoader/,
  /net\.minecraft\.util\.crash\.CrashReport/,
  /A detailed walkthrough of the error/,
];

/** Check if a message contains a crash report signature */
export function detectCrashReport(content: string): { detected: boolean; type: 'paste_link' | 'inline_crash'; matches: string[] } {
  const matches: string[] = [];
  let type: 'paste_link' | 'inline_crash' = 'inline_crash';

  for (const pattern of CRASH_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      matches.push(match[0]);
      // Check if it's a paste link
      if (/https?:\/\//i.test(match[0]!)) {
        type = 'paste_link';
      }
    }
  }

  return { detected: matches.length > 0, type, matches };
}
