/**
 * @edenvanguard/pterodactyl-mcp — Pterodactyl MCP Server Entry Point
 *
 * This is the main entry point for the Pterodactyl MCP server.
 * It initializes the MCP server, loads credentials, registers tools,
 * and starts the stdio transport for JSON-RPC 2.0 communication.
 *
 * Architecture: Aegis invokes Pterodactyl operations exclusively through
 * this MCP server. Aegis NEVER calls Pterodactyl REST endpoints directly.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { credentialLoader } from './auth/credentialLoader.js';
import { registerAllTools } from './tools/registry.js';

const SERVER_NAME = 'pterodactyl-mcp';
const SERVER_VERSION = '0.1.0';

async function main(): Promise<void> {
  // Load Pterodactyl credentials from database
  await credentialLoader.loadAll();
  console.error(
    `Loaded ${credentialLoader.getCredentials('application').length} application keys, ${credentialLoader.getCredentials('client').length} client keys`,
  );

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register all MCP tools (Phase 2)
  registerAllTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`${SERVER_NAME} v${SERVER_VERSION} started on stdio transport`);

  // Handle credential reload signals
  process.on('SIGUSR1', async () => {
    console.error('Received SIGUSR1 — reloading credentials');
    await credentialLoader.reload();
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error starting Pterodactyl MCP server:', error);
  process.exit(1);
});
