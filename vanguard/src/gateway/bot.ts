/**
 * Discord.js Client Setup — Vanguard Gateway
 *
 * Creates and configures the Discord.js Client with the
 * proper intents for Vanguard's event routing needs.
 */

import { Client, GatewayIntentBits } from 'discord.js';

/** Create and configure the Discord.js client */
export function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  });

  client.once('ready', (c) => {
    console.error(`Vanguard ready as ${c.user.tag}`);
  });

  return client;
}
