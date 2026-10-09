/**
 * Slash Command Registration — Vanguard Gateway
 *
 * Defines and registers all slash commands with the Discord API.
 * Vanguard only registers commands; Aegis handles the business logic.
 */

import { REST, Routes, SlashCommandBuilder, type RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';

/** Build all slash command definitions */
export function buildCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return [
    // /aegis crash <paste_url|text>
    new SlashCommandBuilder()
      .setName('aegis')
      .setDescription('Aegis autonomous system commands')
      .addSubcommand(sub =>
        sub.setName('crash')
          .setDescription('Submit a crash report for diagnosis')
          .addStringOption(opt => opt.setName('input').setDescription('Crash log paste URL or text').setRequired(true))
      )
      .addSubcommand(sub =>
        sub.setName('deploy')
          .setDescription('Trigger a deployment job')
          .addStringOption(opt => opt.setName('job_id').setDescription('Maintenance job ID').setRequired(true))
          .addBooleanOption(opt => opt.setName('force').setDescription('Force deploy regardless of player count'))
      )
      .addSubcommand(sub =>
        sub.setName('status')
          .setDescription('Check system or deployment status')
          .addStringOption(opt => opt.setName('job_id').setDescription('Job ID to check').setRequired(false))
      )
      .addSubcommand(sub =>
        sub.setName('force-rollback')
          .setDescription('Force rollback a failed deployment')
          .addStringOption(opt => opt.setName('job_id').setDescription('Job ID').setRequired(true))
      )
      .addSubcommand(sub =>
        sub.setName('health-policy')
          .setDescription('Configure proactive health remediation policy')
          .addStringOption(opt => opt.setName('server').setDescription('Server ID').setRequired(true))
          .addStringOption(opt => opt.setName('policy').setDescription('advisory | warning | critical').setRequired(true))
      )
      .toJSON(),
  ];
}

/** Register commands with Discord API */
export async function registerCommands(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');

  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) throw new Error('DISCORD_CLIENT_ID is not set');

  const rest = new REST({ version: '10' }).setToken(token);
  const commands = buildCommands();

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.error(`Registered ${commands.length} slash commands`);
}
