/**
 * Suggestions Forum Watcher — Vanguard Detection Layer
 *
 * Monitors the Suggestions Forum channel for new threads
 * and extracts structured suggestion data for Aegis evaluation.
 */

import { type ThreadChannel, ChannelType } from 'discord.js';

/** Check if a thread is in the suggestions forum */
export function isSuggestionThread(thread: ThreadChannel): boolean {
  return thread.parent?.type === ChannelType.GuildForum;
}

/** Extract suggestion details from a forum thread */
export async function extractSuggestion(thread: ThreadChannel): Promise<{
  title: string;
  description: string;
  authorId: string;
  threadId: string;
  tags: string[];
} | null> {
  if (!thread.parentId) return null;

  let description = '';
  try {
    const starterMessage = await thread.fetchStarterMessage();
    description = starterMessage?.content ?? '';
  } catch {
    // If we can't fetch the starter message, use empty string
  }

  return {
    title: thread.name,
    description,
    authorId: thread.ownerId ?? '',
    threadId: thread.id,
    tags: thread.appliedTags.map(String),
  };
}
