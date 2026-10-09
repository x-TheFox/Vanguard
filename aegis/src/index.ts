/**
 * @edenvanguard/aegis — Autonomous Intelligence Core Entry Point
 *
 * Aegis is the autonomous decision-making backend. It receives structured
 * task payloads from Vanguard via NATS JetStream, exercises unconstrained
 * executive agency inside its VM sandbox, and streams results back.
 *
 * CRITICAL: Aegis discovers and invokes tools exclusively through the MCP
 * protocol. It NEVER makes direct HTTP calls to Pterodactyl or any
 * external service. All Pterodactyl operations go through:
 *   Aegis.mcp.invoke("tool_name", { params })
 */

import { start } from './core/orchestrator.js';
import { mcpClient } from './mcp/clientManager.js';
import { disconnectNats } from './ipc/nats.js';

async function main(): Promise<void> {
  console.error('Starting Aegis orchestrator...');
  await start();

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.error('Shutting down Aegis...');
    await mcpClient.shutdown();
    await disconnectNats();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error('Fatal error starting Aegis:', error);
  process.exit(1);
});
