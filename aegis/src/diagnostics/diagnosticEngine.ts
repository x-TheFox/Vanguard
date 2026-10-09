/**
 * Diagnostic Engine — Aegis Crash Diagnostics
 *
 * Orchestrates the full crash troubleshooting lifecycle as defined in
 * Section A of 03_state_machines.md.
 *
 * State machine:
 *   IDLE → THREAD_CREATED → DIAGNOSING → {SEARCHING, PARSING_LOG}
 *     → ANALYZING → {ROOT_CAUSE, NEED_MORE_INFO} → {INTERACTING}
 *     → RESOLVED
 *
 * The engine:
 *  1. Parses the crash report (PARSING_LOG)
 *  2. Uses MCP tools to gather additional context (SEARCHING)
 *  3. Sends data to the LLM for root-cause analysis (ANALYZING)
 *  4. Classifies result as ROOT_CAUSE or NEED_MORE_INFO
 *  5. Returns a structured DiagnosticResult
 */

import { mcpClient } from '../mcp/clientManager.js';
import { inferenceClient } from '../inference/client.js';
import { parseCrashReport, type ParsedCrashReport } from './crashParser.js';
import { analyzeServerLog, type LogAnalysis } from './logAnalyzer.js';
import { createCorrelationId } from '@edenvanguard/shared';

// ── Types ──────────────────────────────────────────────────────

/** Diagnostic state as per the Crash Log Troubleshooting Lifecycle */
export type DiagnosticState =
  | 'IDLE'
  | 'THREAD_CREATED'
  | 'DIAGNOSING'
  | 'SEARCHING'
  | 'PARSING_LOG'
  | 'ANALYZING'
  | 'ROOT_CAUSE'
  | 'NEED_MORE_INFO'
  | 'INTERACTING'
  | 'RESOLVED';

export interface DiagnosticResult {
  threadId: string;
  category: ParsedCrashReport['category'];
  rootCause: string;
  fix: string;
  confidence: number; // 0.0 - 1.0
  toolInvocations: Array<{ tool: string; params: Record<string, unknown>; result: unknown }>;
  parsedReport: ParsedCrashReport;
  logAnalysis?: LogAnalysis;
}

/** Internal context carried through the diagnostic lifecycle */
interface DiagnosticContext {
  threadId: string;
  crashContent: string;
  state: DiagnosticState;
  parsedReport: ParsedCrashReport | null;
  logAnalysis: LogAnalysis | null;
  toolInvocations: Array<{ tool: string; params: Record<string, unknown>; result: unknown }>;
  serverId: string | null;
  additionalContext: string;
}

// ── Known Patterns (Knowledge Base Placeholder) ────────────────

/**
 * Known crash patterns that can be resolved immediately without
 * LLM analysis. This will be replaced by a real knowledge base
 * in a future phase.
 */
const KNOWN_PATTERNS: Array<{
  pattern: RegExp;
  category: ParsedCrashReport['category'];
  rootCause: string;
  fix: string;
  confidence: number;
}> = [
  {
    pattern: /java\.lang\.OutOfMemoryError:\s*Metaspace/i,
    category: 'out_of_memory',
    rootCause: 'Metaspace (class metadata) exhausted',
    fix: 'Add -XX:MaxMetaspaceSize=256M or higher to your JVM flags. This often happens with many mods that load many classes.',
    confidence: 0.95,
  },
  {
    pattern: /java\.lang\.OutOfMemoryError:\s*Java heap space/i,
    category: 'out_of_memory',
    rootCause: 'JVM heap space exhausted',
    fix: 'Increase -Xmx to at least 4-6 GB for modded Minecraft. Also check for memory-intensive mods or world generation issues that may cause memory leaks.',
    confidence: 0.98,
  },
  {
    pattern: /java\.lang\.OutOfMemoryError/i,
    category: 'out_of_memory',
    rootCause: 'JVM ran out of heap memory',
    fix: 'Increase the JVM -Xmx allocation in your server start script. For modded servers, 4-6 GB minimum is recommended. Ensure -Xmx is set in your launch flags (e.g., -Xmx4G).',
    confidence: 0.95,
  },
  {
    pattern: /net\.minecraft\.class_\d+.*NoClassDefFoundError/i,
    category: 'version_mismatch',
    rootCause: 'Fabric intermediary class missing — mod compiled for a different Minecraft version',
    fix: 'Ensure all mods are compiled for the same Minecraft and Fabric Loader version. Update or remove the offending mod.',
    confidence: 0.85,
  },
  {
    pattern: /cpw\.mods\.modlauncher\.TransformationServiceDecorator/i,
    category: 'mod_conflict',
    rootCause: 'Forge mod loading failure — conflicting or broken mod',
    fix: 'Identify the failing mod from the stack trace and update it, or remove it temporarily to isolate the conflict.',
    confidence: 0.75,
  },
  {
    pattern: /Duplicate\s+mod/i,
    category: 'mod_conflict',
    rootCause: 'Duplicate mod files detected',
    fix: 'Remove duplicate mod JARs from the mods/ folder. Only keep one version of each mod.',
    confidence: 0.95,
  },
];

// ── Diagnostic Engine ──────────────────────────────────────────

export class DiagnosticEngine {
  /**
   * Run the full diagnostic lifecycle for a crash report.
   *
   * Follows the state machine from IDLE → RESOLVED,
   * gathering context via MCP tools and LLM analysis.
   */
  async diagnose(threadId: string, crashContent: string): Promise<DiagnosticResult> {
    const ctx: DiagnosticContext = {
      threadId,
      crashContent,
      state: 'THREAD_CREATED',
      parsedReport: null,
      logAnalysis: null,
      toolInvocations: [],
      serverId: null,
      additionalContext: '',
    };

    try {
      // DIAGNOSING: Parse the crash report
      ctx.state = 'DIAGNOSING';
      await this.runParsingPhase(ctx);

      // Check known patterns for immediate resolution
      const knownMatch = this.matchKnownPattern(ctx.parsedReport!);
      if (knownMatch) {
        ctx.state = 'ROOT_CAUSE';
        return this.buildResult(ctx, knownMatch.rootCause, knownMatch.fix, knownMatch.confidence);
      }

      // SEARCHING: Gather additional context via MCP tools
      ctx.state = 'SEARCHING';
      await this.runSearchPhase(ctx);

      // ANALYZING: Send to LLM for root-cause analysis
      ctx.state = 'ANALYZING';
      const analysis = await this.runAnalysisPhase(ctx);

      // Classify result
      if (analysis.confidence >= 0.5 || analysis.rootCause.length > 0) {
        ctx.state = 'ROOT_CAUSE';
        return this.buildResult(ctx, analysis.rootCause, analysis.fix, analysis.confidence);
      }

      // Need more information
      ctx.state = 'NEED_MORE_INFO';
      return this.buildResult(
        ctx,
        analysis.rootCause || 'Insufficient information for definitive diagnosis',
        analysis.fix || 'Please provide additional context: mod list, server configuration, or the full latest.log file.',
        analysis.confidence,
      );
    } catch (error) {
      // Error recovery: return partial results
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.buildResult(
        ctx,
        `Diagnostic error: ${errorMessage}`,
        'The automated diagnostic encountered an error. An admin has been notified and will assist shortly.',
        0.0,
      );
    }
  }

  // ── Phase: PARSING_LOG ───────────────────────────────────────

  private async runParsingPhase(ctx: DiagnosticContext): Promise<void> {
    ctx.state = 'PARSING_LOG';

    // Parse the crash report
    ctx.parsedReport = parseCrashReport(ctx.crashContent);

    // If there's a server.log portion embedded (or we can fetch it via MCP),
    // also analyze the server log
    if (ctx.parsedReport.category === 'unknown' || ctx.parsedReport.category === 'mod_conflict') {
      // Try to fetch server.log via MCP if a server is identified
      const serverLog = await this.tryFetchServerLog(ctx);
      if (serverLog) {
        ctx.logAnalysis = analyzeServerLog(serverLog);
      }
    }
  }

  // ── Phase: SEARCHING ─────────────────────────────────────────

  private async runSearchPhase(ctx: DiagnosticContext): Promise<void> {
    ctx.state = 'SEARCHING';

    const report = ctx.parsedReport!;

    // Step 1: List servers to identify the target
    const serverListResult = await this.safeInvokeTool(ctx, 'list_servers', {});
    if (serverListResult) {
      // Try to identify which server had the crash based on the report content
      ctx.serverId = this.identifyServerId(serverListResult, report);
    }

    // Step 2: Get server resources if we have a server ID
    if (ctx.serverId) {
      const resourcesResult = await this.safeInvokeTool(ctx, 'get_server_resources', {
        server_id: ctx.serverId,
      });

      if (resourcesResult && report.category === 'out_of_memory') {
        ctx.additionalContext += `\nServer Resources: ${JSON.stringify(resourcesResult)}`;
      }
    }

    // Step 3: Try to get mod list from the server
    if (ctx.serverId) {
      const modListResult = await this.safeInvokeTool(ctx, 'list_files', {
        server_id: ctx.serverId,
        path: '/mods',
      });

      if (modListResult) {
        ctx.additionalContext += `\nServer Mod List: ${JSON.stringify(modListResult)}`;
      }
    }

    // Step 4: Try to read server config for version mismatch diagnoses
    if (ctx.serverId && (report.category === 'version_mismatch' || report.category === 'config_error')) {
      const configResult = await this.safeInvokeTool(ctx, 'read_file', {
        server_id: ctx.serverId,
        path: '/server.properties',
      });

      if (configResult) {
        ctx.additionalContext += `\nServer Properties: ${JSON.stringify(configResult)}`;
      }
    }
  }

  // ── Phase: ANALYZING ─────────────────────────────────────────

  private async runAnalysisPhase(ctx: DiagnosticContext): Promise<{
    rootCause: string;
    fix: string;
    confidence: number;
  }> {
    ctx.state = 'ANALYZING';

    const report = ctx.parsedReport!;
    const logSummary = ctx.logAnalysis
      ? `Log Analysis:\n` +
        `- Errors: ${ctx.logAnalysis.errorCount}\n` +
        `- Warnings: ${ctx.logAnalysis.warningCount}\n` +
        `- Memory Pressure: ${ctx.logAnalysis.memoryPressure}\n` +
        `- TPS Degradation: ${ctx.logAnalysis.tpsDegradation}\n` +
        `- Key Findings: ${ctx.logAnalysis.keyFindings.join('; ')}\n` +
        `- Mod Failures: ${ctx.logAnalysis.modFailures.join(', ') || 'None detected'}\n` +
        `- Repeating Errors: ${ctx.logAnalysis.repeatingErrors.map((e) => `${e.pattern} (${e.count}x)`).join(', ') || 'None'}\n`
      : 'No server log analysis available.';

    const systemPrompt = `You are a Minecraft server diagnostic expert. Analyze the crash report and supporting data to determine:
1. The root cause of the crash
2. A specific, actionable fix

Respond with a JSON object with exactly these fields:
- "rootCause": A clear, 1-2 sentence explanation of what caused the crash
- "fix": A specific, actionable step-by-step fix the player should follow
- "confidence": A number from 0.0 to 1.0 indicating your confidence in this diagnosis

Be specific about mod names, version numbers, and configuration changes. If uncertain, set confidence below 0.5.`;

    const userPrompt = `Crash Report Analysis:
- Crash Type: ${report.crashType}
- Category: ${report.category}
- Root Exception: ${report.rootException}: ${report.rootMessage}
- Stack Trace (top frames): ${report.stackTrace.slice(0, 10).join('\n  ')}
- Detected Mod IDs: ${report.modIds.join(', ') || 'None detected'}
- Java Version: ${report.javaVersion ?? 'Unknown'}
- Minecraft Version: ${report.minecraftVersion ?? 'Unknown'}
- JVM Memory (-Xmx): ${report.jvmMemory ?? 'Unknown'}

${logSummary}

${ctx.additionalContext ? `Additional Context from MCP tools:\n${ctx.additionalContext}` : ''}

Raw crash excerpt (first 3000 chars):
${report.rawContent.substring(0, 3000)}`;

    const response = await inferenceClient.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      correlationId: createCorrelationId(),
      temperature: 0.2, // Low temperature for factual diagnosis
    });

    return this.parseAnalysisResponse(response.content);
  }

  // ── Known Pattern Matching ───────────────────────────────────

  private matchKnownPattern(
    report: ParsedCrashReport,
  ): { rootCause: string; fix: string; confidence: number } | null {
    for (const known of KNOWN_PATTERNS) {
      // Test against both the raw content and the root exception
      if (known.pattern.test(report.rawContent) || known.pattern.test(report.rootException)) {
        return {
          rootCause: known.rootCause,
          fix: known.fix,
          confidence: known.confidence,
        };
      }
    }
    return null;
  }

  // ── MCP Tool Helpers ─────────────────────────────────────────

  /**
   * Safely invoke an MCP tool, recording the invocation on the
   * diagnostic context regardless of outcome.
   */
  private async safeInvokeTool(
    ctx: DiagnosticContext,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      if (!mcpClient.isToolAvailable(toolName)) {
        return null;
      }

      const result = await mcpClient.invoke(toolName, params);
      ctx.toolInvocations.push({ tool: toolName, params, result });
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      ctx.toolInvocations.push({ tool: toolName, params, result: { error: errorMessage } });
      return null;
    }
  }

  /** Try to fetch the server log via MCP tools */
  private async tryFetchServerLog(ctx: DiagnosticContext): Promise<string | null> {
    // First, identify the server
    const serverListResult = await this.safeInvokeTool(ctx, 'list_servers', {});
    if (!serverListResult) return null;

    ctx.serverId = this.identifyServerId(serverListResult, ctx.parsedReport!);
    if (!ctx.serverId) return null;

    // Try to read the latest.log file
    const logResult = await this.safeInvokeTool(ctx, 'read_file', {
      server_id: ctx.serverId,
      path: '/logs/latest.log',
    });

    if (logResult && typeof logResult === 'object') {
      // MCP tool results come as { content: [{ type: 'text', text: '...' }] }
      const result = logResult as { content?: Array<{ type?: string; text?: string }> };
      if (result.content && Array.isArray(result.content)) {
        const textContent = result.content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n');
        if (textContent.length > 0) {
          return textContent;
        }
      }
      // Fallback: try stringifying
      return JSON.stringify(logResult);
    }

    return null;
  }

  /** Attempt to identify which server the crash belongs to */
  private identifyServerId(serverList: unknown, report: ParsedCrashReport): string | null {
    // serverList is expected to be an array of server objects
    if (Array.isArray(serverList)) {
      // If there's only one server, use it
      if (serverList.length === 1) {
        const server = serverList[0] as Record<string, unknown>;
        return (server.identifier ?? server.uuid ?? server.id ?? null) as string | null;
      }

      // Try to match by Minecraft version in server name
      if (report.minecraftVersion) {
        for (const server of serverList) {
          const s = server as Record<string, unknown>;
          const name = String(s.name ?? '');
          if (name.includes(report.minecraftVersion)) {
            return (s.identifier ?? s.uuid ?? s.id ?? null) as string | null;
          }
        }
      }

      // Return the first non-suspended server
      for (const server of serverList) {
        const s = server as Record<string, unknown>;
        if (!s.isSuspended) {
          return (s.identifier ?? s.uuid ?? s.id ?? null) as string | null;
        }
      }
    }

    // MCP result format: { content: [{ type: 'text', text: '...' }] }
    if (serverList && typeof serverList === 'object') {
      const result = serverList as { content?: Array<{ type?: string; text?: string }> };
      if (result.content && Array.isArray(result.content)) {
        const text = result.content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n');
        if (text) {
          try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const server = parsed[0] as Record<string, unknown>;
              return (server.identifier ?? server.uuid ?? server.id ?? null) as string | null;
            }
          } catch {
            // Not JSON, can't parse
          }
        }
      }
    }

    return null;
  }

  // ── Response Parsing ─────────────────────────────────────────

  /** Parse the LLM analysis response into structured data */
  private parseAnalysisResponse(content: string): {
    rootCause: string;
    fix: string;
    confidence: number;
  } {
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          rootCause?: string;
          fix?: string;
          confidence?: number;
        };
        return {
          rootCause: parsed.rootCause ?? 'Unable to determine root cause',
          fix: parsed.fix ?? 'Please review the crash report manually or provide more information.',
          confidence: typeof parsed.confidence === 'number'
            ? Math.max(0, Math.min(1, parsed.confidence))
            : 0.3,
        };
      }
    } catch {
      // JSON parse failed — fall through to text extraction
    }

    // Fallback: use the raw response as the root cause
    return {
      rootCause: content.substring(0, 500),
      fix: 'Review the crash report and the analysis above for guidance.',
      confidence: 0.2,
    };
  }

  // ── Result Builder ───────────────────────────────────────────

  private buildResult(
    ctx: DiagnosticContext,
    rootCause: string,
    fix: string,
    confidence: number,
  ): DiagnosticResult {
    ctx.state = 'RESOLVED';

    return {
      threadId: ctx.threadId,
      category: ctx.parsedReport?.category ?? 'unknown',
      rootCause,
      fix,
      confidence,
      toolInvocations: ctx.toolInvocations,
      parsedReport: ctx.parsedReport ?? {
        crashType: 'Unknown',
        rootException: 'UnknownException',
        rootMessage: '',
        stackTrace: [],
        modIds: [],
        javaVersion: null,
        minecraftVersion: null,
        jvmMemory: null,
        category: 'unknown',
        rawContent: ctx.crashContent,
      },
      logAnalysis: ctx.logAnalysis ?? undefined,
    };
  }
}

/**
 * Singleton diagnostic engine instance.
 *
 * Usage:
 *   const result = await diagnosticEngine.diagnose(threadId, crashContent);
 */
export const diagnosticEngine = new DiagnosticEngine();
