/**
 * Console Tools — MCP tool implementations for console access
 *
 * Tools:
 * - send_command (Client API via WebSocket, command-blocker validated)
 * - get_player_count (Composite: sends `list`, parses output)
 * - get_console_output (Returns buffered console output)
 */

import { wsManager } from '../websocket/client.js';
import { validateCommand } from '../safety/commandBlocker.js';
import { redactSecrets } from '@edenvanguard/shared';
import type { WsEvent } from '../websocket/client.js';

// ── Helpers ───────────────────────────────────────────────────

function toolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

function handleError(error: unknown, toolName: string) {
  const msg = error instanceof Error ? error.message : String(error);
  return errorResult(`[${toolName}] ${redactSecrets(msg)}`);
}

// ── send_command ──────────────────────────────────────────────

export interface SendCommandParams {
  server_id: string;
  command: string;
}

export async function sendCommand(params: SendCommandParams) {
  try {
    // Validate command against blocked patterns
    const validation = validateCommand(params.command);
    if (!validation.allowed) {
      return errorResult(validation.reason ?? `Command "${params.command}" is blocked for safety reasons`);
    }

    // Ensure WebSocket connection is established
    await wsManager.connect(params.server_id);

    // Send the command via WebSocket
    wsManager.sendCommand(params.server_id, params.command);

    return toolResult({ success: true, server_id: params.server_id, command: params.command });
  } catch (error: unknown) {
    return handleError(error, 'send_command');
  }
}

// ── get_player_count ──────────────────────────────────────────

export interface GetPlayerCountParams {
  server_id: string;
  timeout_seconds?: number;
}

export async function getPlayerCount(params: GetPlayerCountParams) {
  try {
    const timeoutMs = (params.timeout_seconds ?? 10) * 1000;

    // Ensure WebSocket connection
    await wsManager.connect(params.server_id);

    // Set up listener for console output that contains player count
    const playerCountPromise = new Promise<{
      player_count: number;
      max_players: number;
      players: string[];
      raw_output: string;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error('Timed out waiting for player count response'));
      }, timeoutMs);

      const onEvent = (event: WsEvent) => {
        if (event.type === 'console_output' && typeof event.data === 'string') {
          const line = event.data;
          // Parse Minecraft "list" command output:
          // "There are 5 of a max of 20 players online: Steve, Alex, Notch"
          const match = line.match(
            /There are (\d+) of a max of (\d+) players online(?:[:]\s*(.*))?/i,
          );
          if (match) {
            clearTimeout(timeout);
            unsubscribe();

            const playerCount = parseInt(match[1]!, 10);
            const maxPlayers = parseInt(match[2]!, 10);
            const playersStr = match[3] ?? '';
            const players = playersStr
              .split(',')
              .map((p) => p.trim())
              .filter((p) => p.length > 0);

            resolve({
              player_count: playerCount,
              max_players: maxPlayers,
              players,
              raw_output: line,
            });
          }
        }
      };

      const unsubscribe = wsManager.subscribe(params.server_id, onEvent);

      // Send the "list" command to trigger the response
      try {
        wsManager.sendCommand(params.server_id, 'list');
      } catch (err: unknown) {
        clearTimeout(timeout);
        unsubscribe();
        reject(err);
      }
    });

    const result = await playerCountPromise;
    return toolResult(result);
  } catch (error: unknown) {
    // Return -1 for player count if we can't determine it
    const msg = error instanceof Error ? error.message : String(error);
    return toolResult({
      player_count: -1,
      max_players: -1,
      players: [],
      raw_output: '',
      error: redactSecrets(msg),
    });
  }
}

// ── get_console_output ────────────────────────────────────────

export interface GetConsoleOutputParams {
  server_id: string;
  lines?: number;
}

export async function getConsoleOutput(params: GetConsoleOutputParams) {
  try {
    const requestedLines = Math.min(params.lines ?? 50, 200);
    const buffer = wsManager.getConsoleBuffer(params.server_id);

    // Get the last N lines from the buffer
    const recentLines = buffer.slice(-requestedLines);

    return toolResult({
      server_id: params.server_id,
      lines: recentLines.length,
      output: recentLines,
    });
  } catch (error: unknown) {
    return handleError(error, 'get_console_output');
  }
}
