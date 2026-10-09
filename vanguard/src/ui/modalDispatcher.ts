/**
 * Admin Modal Dispatch — Vanguard UI Layer
 *
 * Builds Discord modals for admin review of suggestions.
 * Vanguard renders the UI; Aegis processes the decisions.
 */

import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';

/** Build an admin notes modal for suggestion review */
export function buildAdminNotesModal(jobId: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`admin_notes:${jobId}`)
    .setTitle('Admin Review Notes');

  const notesInput = new TextInputBuilder()
    .setCustomId('notes')
    .setLabel('Review Notes')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Enter your review notes...')
    .setRequired(false);

  const actionInput = new TextInputBuilder()
    .setCustomId('action')
    .setLabel('Action (approve/reject)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('approve or reject')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(notesInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(actionInput),
  );

  return modal;
}
