/**
 * @edenvanguard/vanguard — Discord Gateway Bot Entry Point
 *
 * Vanguard is the Discord-facing event gateway. It owns all WebSocket
 * listeners, slash-command registrations, modal dispatchers, and
 * message-intercept pipelines. Vanguard is deliberately thin:
 * it routes, validates, and delegates to Aegis via NATS JetStream.
 */

import { createDiscordClient } from './gateway/bot.js';
import { registerEventHandlers } from './gateway/eventHandlers.js';
import { connectNats, disconnectNats } from './ipc/nats.js';

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('DISCORD_BOT_TOKEN environment variable is not set');
    process.exit(1);
  }

  // Connect to NATS
  await connectNats();

  // Create Discord client
  const client = createDiscordClient();

  // Register event handlers
  registerEventHandlers(client);

  // Login to Discord
  await client.login(token);

  // Graceful shutdown
  const shutdown = async () => {
    console.error('Shutting down Vanguard...');
    client.destroy();
    await disconnectNats();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error('Fatal error starting Vanguard:', error);
  process.exit(1);
});
