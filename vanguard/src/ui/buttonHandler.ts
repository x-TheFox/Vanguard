/**
 * Button Interaction Handler — Vanguard UI Layer
 *
 * Handles approval/rejection buttons for suggestions and deployments.
 * Parses custom IDs and validates admin permissions before
 * delegating to Aegis via NATS.
 */

import { ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';

/** Build approve/reject button row for a suggestion */
export function buildApprovalButtons(threadId: string): ActionRowBuilder<ButtonBuilder> {
  const approve = new ButtonBuilder()
    .setCustomId(`suggestion:approve:${threadId}`)
    .setLabel('Approve')
    .setStyle(ButtonStyle.Success)
    .setEmoji('✅');

  const reject = new ButtonBuilder()
    .setCustomId(`suggestion:reject:${threadId}`)
    .setLabel('Reject')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('❌');

  return new ActionRowBuilder<ButtonBuilder>().addComponents(approve, reject);
}

/** Parse a button interaction custom ID */
export function parseButtonAction(customId: string): { type: string; action: string; targetId: string } | null {
  const parts = customId.split(':');
  if (parts.length !== 3) return null;
  return { type: parts[0]!, action: parts[1]!, targetId: parts[2]! };
}

/** Check if the user is an admin */
export function isAdmin(userId: string): boolean {
  const adminIds = (process.env.ADMIN_DISCORD_IDS ?? '').split(',').map(s => s.trim());
  return adminIds.includes(userId);
}
