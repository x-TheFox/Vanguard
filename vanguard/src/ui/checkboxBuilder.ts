/**
 * Mod Selection Checkboxes — Vanguard UI Layer
 *
 * Builds Discord UI components for mod selection in suggestion evaluation.
 * Used when Aegis returns mod suggestions and admins need to pick
 * which mods to include in a deployment.
 */

import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';

/** Build a mod selection dropdown for a suggestion evaluation */
export function buildModSelectMenu(
  mods: Array<{ name: string; id: string; version: string }>,
  customId: string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Select mods to include in deployment...')
    .setMinValues(0)
    .setMaxValues(mods.length)
    .addOptions(
      mods.map(mod => ({
        label: `${mod.name} v${mod.version}`,
        description: `Mod ID: ${mod.id}`,
        value: mod.id,
      }))
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}
