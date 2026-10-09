/**
 * MCP Client Manager — Aegis's interface to the MCP world
 *
 * Manages connections to MCP servers (starting with the Pterodactyl MCP server)
 * and provides the invoke() method that all Aegis components use.
 *
 * CRITICAL: Aegis NEVER calls Pterodactyl REST directly.
 * ALL Pterodactyl operations go through mcpClient.invoke("tool_name", params).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ── Circuit Breaker ────────────────────────────────────────────

class CircuitBreaker {
  private failureCount = 0;
  private readonly threshold = 5;
  private readonly resetDelay = 30_000;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private lastFailureAt: Date | null = null;

  get isOpen(): boolean {
    if (this.state === 'open') {
      // Check if we should try half-open
      if (this.lastFailureAt && Date.now() - this.lastFailureAt.getTime() > this.resetDelay) {
        this.state = 'half-open';
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureAt = new Date();
    if (this.failureCount >= this.threshold) {
      this.state = 'open';
    }
  }
}

// ── Types ──────────────────────────────────────────────────────

interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConnection {
  client: Client;
  transport: StdioClientTransport;
  serverName: string;
  tools: Map<string, { description: string; inputSchema: unknown }>;
  circuitBreaker: CircuitBreaker;
}

// ── MCP Client Manager ─────────────────────────────────────────

class McpClientManager {
  private connections = new Map<string, McpConnection>();
  private initialized = false;

  /** Connect to an MCP server via stdio transport */
  async connect(config: McpServerConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
    });

    const client = new Client({
      name: 'aegis',
      version: '0.1.0',
    });

    await client.connect(transport);

    // Discover available tools
    const toolsResult = await client.listTools();
    const tools = new Map<string, { description: string; inputSchema: unknown }>();
    for (const tool of toolsResult.tools) {
      tools.set(tool.name, {
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
      });
    }

    this.connections.set(config.name, {
      client,
      transport,
      serverName: config.name,
      tools,
      circuitBreaker: new CircuitBreaker(),
    });
  }

  /** Invoke an MCP tool by name */
  async invoke(toolName: string, params: Record<string, unknown> = {}): Promise<unknown> {
    // Find which server has this tool
    for (const [serverName, connection] of this.connections) {
      if (connection.tools.has(toolName)) {
        if (connection.circuitBreaker.isOpen) {
          throw new Error(
            `MCP server "${serverName}" circuit breaker is open. Tool "${toolName}" is unavailable.`,
          );
        }

        try {
          const result = await connection.client.callTool({
            name: toolName,
            arguments: params,
          });
          connection.circuitBreaker.recordSuccess();
          return result;
        } catch (error) {
          connection.circuitBreaker.recordFailure();
          throw error;
        }
      }
    }

    throw new Error(
      `No MCP server provides tool "${toolName}". Available tools: ${this.listAvailableTools().join(', ')}`,
    );
  }

  /** List all available tools across all connected servers */
  listAvailableTools(): string[] {
    const tools: string[] = [];
    for (const connection of this.connections.values()) {
      if (!connection.circuitBreaker.isOpen) {
        tools.push(...connection.tools.keys());
      }
    }
    return tools;
  }

  /** Check if a specific tool is available */
  isToolAvailable(toolName: string): boolean {
    for (const connection of this.connections.values()) {
      if (connection.tools.has(toolName) && !connection.circuitBreaker.isOpen) {
        return true;
      }
    }
    return false;
  }

  /** Initialize all MCP connections from configuration */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Connect to Pterodactyl MCP server
    await this.connect({
      name: 'pterodactyl',
      command: 'node',
      args: ['../pterodactyl-mcp/dist/index.js'],
    });

    this.initialized = true;
  }

  /** Disconnect from all MCP servers */
  async shutdown(): Promise<void> {
    for (const connection of this.connections.values()) {
      await connection.client.close();
    }
    this.connections.clear();
    this.initialized = false;
  }
}

/** Singleton MCP client manager instance */
export const mcpClient = new McpClientManager();
