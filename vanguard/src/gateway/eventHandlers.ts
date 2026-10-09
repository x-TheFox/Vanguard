/**
 * Discord Event Handlers — Vanguard Gateway
 *
 * Wires up all Discord events: message create, interaction create,
 * thread create, etc. Vanguard detects, validates, and delegates
 * to Aegis via NATS JetStream. It does NOT think or make decisions.
 */

import { type Client, type Message, type Interaction, type ThreadChannel, Events } from 'discord.js';
import { detectCrashReport } from '../detection/crashDetector.js';
import { fetchPasteContent } from '../detection/pasteLinkExtractor.js';
import { isSuggestionThread, extractSuggestion } from '../detection/forumWatcher.js';
import { buildApprovalButtons, parseButtonAction, isAdmin } from '../ui/buttonHandler.js';
import { publish } from '../ipc/nats.js';
import { NATS_SUBJECTS } from '@edenvanguard/shared';

/** Register all Discord event handlers */
export function registerEventHandlers(client: Client): void {
  // Message Create — detect crash reports
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    const detection = detectCrashReport(message.content);
    if (!detection.detected) return;

    try {
      // Create a thread for the crash report
      const thread = await message.startThread({
        name: `Crash Report — ${message.author.username}`,
        autoArchiveDuration: 60,
      });

      await thread.send('🔍 Aegis is analyzing this crash report...');

      // Extract paste content if it's a link
      let crashContent = message.content;
      if (detection.type === 'paste_link') {
        for (const match of detection.matches) {
          try {
            crashContent = await fetchPasteContent(match);
            break; // Use the first successful paste
          } catch {
            // Try next match
          }
        }
      }

      // Publish to Aegis via NATS
      await publish(NATS_SUBJECTS.CRASH_NEW, {
        threadId: thread.id,
        channelId: message.channelId,
        guildId: message.guildId,
        reporterId: message.author.id,
        crashContent,
        sourceType: detection.type,
      });

    } catch (error) {
      console.error('Error handling crash report:', error);
    }
  });

  // Thread Create — watch for suggestion forum posts
  client.on(Events.ThreadCreate, async (thread: ThreadChannel) => {
    if (thread.ownerId === client.user?.id) return; // Ignore our own threads

    if (isSuggestionThread(thread)) {
      const suggestion = await extractSuggestion(thread);
      if (!suggestion) return;

      try {
        // Post initial evaluation message
        const message = await thread.send({
          content: '📋 Aegis is evaluating this suggestion...',
          components: [buildApprovalButtons(thread.id)],
        });

        // Publish to Aegis for evaluation
        await publish(NATS_SUBJECTS.SUGGESTION_NEW, {
          ...suggestion,
          messageId: message.id,
        });
      } catch (error) {
        console.error('Error handling suggestion thread:', error);
      }
    }
  });

  // Interaction Create — handle slash commands and buttons
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    }
  });
}

/** Handle slash command interactions */
async function handleSlashCommand(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
  const { commandName } = interaction;

  if (commandName === 'aegis') {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'crash': {
        const input = interaction.options.getString('input', true);
        await interaction.reply({ content: '🔍 Submitting crash report for analysis...', ephemeral: true });

        await publish(NATS_SUBJECTS.CRASH_NEW, {
          threadId: interaction.channelId,
          channelId: interaction.channelId,
          guildId: interaction.guildId,
          reporterId: interaction.user.id,
          crashContent: input,
          sourceType: 'manual_command',
        });
        break;
      }
      case 'deploy': {
        if (!isAdmin(interaction.user.id)) {
          await interaction.reply({ content: '⛔ Admin only', ephemeral: true });
          return;
        }
        const jobId = interaction.options.getString('job_id', true);
        const force = interaction.options.getBoolean('force') ?? false;

        await publish(NATS_SUBJECTS.ADMIN_COMMAND, {
          command: 'deploy',
          jobId,
          force,
          requestedBy: interaction.user.id,
        });
        await interaction.reply({ content: `🚀 Deployment ${jobId} initiated${force ? ' (forced)' : ''}`, ephemeral: true });
        break;
      }
      case 'status': {
        const jobId = interaction.options.getString('job_id');
        await publish(NATS_SUBJECTS.ADMIN_COMMAND, {
          command: 'status',
          jobId,
          requestedBy: interaction.user.id,
        });
        await interaction.reply({ content: '📊 Checking status...', ephemeral: true });
        break;
      }
      case 'force-rollback': {
        if (!isAdmin(interaction.user.id)) {
          await interaction.reply({ content: '⛔ Admin only', ephemeral: true });
          return;
        }
        const jobId = interaction.options.getString('job_id', true);
        await publish(NATS_SUBJECTS.ADMIN_COMMAND, {
          command: 'force_rollback',
          jobId,
          requestedBy: interaction.user.id,
        });
        await interaction.reply({ content: `⏪ Rolling back ${jobId}...`, ephemeral: true });
        break;
      }
      default:
        await interaction.reply({ content: 'Unknown subcommand', ephemeral: true });
    }
  }
}

/** Handle button interactions */
async function handleButtonInteraction(interaction: import('discord.js').ButtonInteraction): Promise<void> {
  const parsed = parseButtonAction(interaction.customId);
  if (!parsed) return;

  if (parsed.type === 'suggestion') {
    if (!isAdmin(interaction.user.id)) {
      await interaction.reply({ content: '⛔ Only admins can approve/reject suggestions', ephemeral: true });
      return;
    }

    await publish(NATS_SUBJECTS.ADMIN_COMMAND, {
      command: parsed.action === 'approve' ? 'suggestion_approve' : 'suggestion_reject',
      threadId: parsed.targetId,
      requestedBy: interaction.user.id,
    });

    const emoji = parsed.action === 'approve' ? '✅' : '❌';
    await interaction.reply({ content: `${emoji} Suggestion ${parsed.action}d`, ephemeral: true });
  }
}
