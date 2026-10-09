/**
 * Tool Registry — Registers all MCP tools on the McpServer
 *
 * Imports all tool implementations and their handlers, then calls
 * server.tool() for each with Zod-based input schemas.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Tool implementations
import {
  listServers,
  getServer,
  getServerResources,
  startServer,
  stopServer,
  restartServer,
  killServer,
} from './serverManagement.js';

import {
  listFiles,
  readFile,
  writeFile,
  uploadFile,
  deleteFiles,
  renameFiles,
  createFolder,
} from './fileManagement.js';

import {
  listBackups,
  createBackup,
  getBackupStatus,
  restoreBackup,
  deleteBackup,
} from './backupManagement.js';

import {
  sendCommand,
  getPlayerCount,
  getConsoleOutput,
} from './consoleTools.js';

import {
  listSchedules,
  createSchedule,
} from './scheduleTools.js';

import {
  getBuildConfig,
  updateBuildConfig,
  updateStartup,
} from './applicationTools.js';

/**
 * Register all MCP tools on the given McpServer instance.
 */
export function registerAllTools(server: McpServer): void {
  // ── Server Management ──────────────────────────────────────────

  server.tool(
    'list_servers',
    'List all servers accessible via the configured Pterodactyl credentials. Returns complete server details including UUID, name, node, and resource allocations. Automatically paginates through all results.',
    {
      filter_name: z.string().optional().describe('Optional: filter servers by name (substring match)'),
    },
    async (params) => listServers(params),
  );

  server.tool(
    'get_server',
    'Get detailed information about a specific Pterodactyl server including UUID, name, node, allocation, limits, container, and startup configuration.',
    {
      server_id: z.string().describe('Server identifier (UUID or short ID)'),
    },
    async (params) => getServer(params),
  );

  server.tool(
    'get_server_resources',
    'Get current resource usage for a server including CPU percentage, memory bytes, disk bytes, and network I/O. Also returns the current power state. Note: player count is NOT included — use get_player_count tool instead.',
    {
      server_id: z.string().describe('Server identifier (UUID or short ID)'),
    },
    async (params) => getServerResources(params),
  );

  server.tool(
    'start_server',
    'Send a start signal to the server. If the server is already running, this is a no-op. If it is starting or stopping, the signal is queued.',
    {
      server_id: z.string().describe('Server identifier'),
    },
    async (params) => startServer(params),
  );

  server.tool(
    'stop_server',
    'Send a graceful stop signal to the server. The server process receives a stop command and is given time to shut down cleanly. If the server does not stop within the configured timeout, use kill_server. Requires confirm: true.',
    {
      server_id: z.string().describe('Server identifier'),
      confirm: z.boolean().describe('Must be true to execute this dangerous operation').default(false),
    },
    async (params) => stopServer(params),
  );

  server.tool(
    'restart_server',
    'Send a restart signal to the server. This performs a graceful stop followed by an automatic start.',
    {
      server_id: z.string().describe('Server identifier'),
    },
    async (params) => restartServer(params),
  );

  server.tool(
    'kill_server',
    'Force-kill the server process immediately. This is destructive and may cause data loss. Use only when graceful stop fails. Requires explicit confirmation.',
    {
      server_id: z.string().describe('Server identifier'),
      confirm: z.boolean().describe('Must be true to execute this dangerous operation').default(false),
    },
    async (params) => killServer(params),
  );

  // ── File Management ────────────────────────────────────────────

  server.tool(
    'list_files',
    'List the contents of a directory on the server. Returns file names, sizes, modification dates, and whether each entry is a file or directory. Paths are relative to the server root.',
    {
      server_id: z.string().describe('Server identifier'),
      directory: z.string().describe('Directory path relative to server root. Default: "/"').default('/'),
    },
    async (params) => listFiles(params),
  );

  server.tool(
    'read_file',
    'Read the contents of a file from the server. Returns the raw text content. For binary files, use download_file instead. Files larger than 1MB are truncated with a warning.',
    {
      server_id: z.string().describe('Server identifier'),
      file_path: z.string().describe('File path relative to server root (e.g., "/mods/alex-mobs.jar")'),
    },
    async (params) => readFile(params),
  );

  server.tool(
    'write_file',
    'Write content to a file on the server. Creates the file if it does not exist. Overwrites the file if it does exist. Path traversal attempts (..) are rejected. Maximum content size: 5MB.',
    {
      server_id: z.string().describe('Server identifier'),
      file_path: z.string().describe('Target file path relative to server root'),
      content: z.string().describe('File content to write'),
    },
    async (params) => writeFile(params),
  );

  server.tool(
    'upload_file',
    'Upload a file to the server. The file content is provided as base64-encoded data. The MCP server handles the two-step Pterodactyl upload process internally (obtain signed URL, then PUT data). Maximum file size: 100MB.',
    {
      server_id: z.string().describe('Server identifier'),
      target_path: z.string().describe('Target file path on the server'),
      file_data_base64: z.string().describe('Base64-encoded file content'),
      file_size_bytes: z.number().describe('Size of the decoded file in bytes (for validation)'),
    },
    async (params) => uploadFile(params),
  );

  server.tool(
    'delete_files',
    'Delete files or directories on the server. This operation is irreversible. Requires explicit confirmation. Path traversal attempts are rejected.',
    {
      server_id: z.string().describe('Server identifier'),
      root: z.string().describe('Root directory. Default: "/"').default('/'),
      files: z.array(z.string()).describe('Array of file paths to delete'),
      confirm: z.boolean().describe('Must be true to execute this dangerous operation').default(false),
    },
    async (params) => deleteFiles(params),
  );

  server.tool(
    'rename_files',
    'Rename or move files on the server. Accepts an array of {from, to} pairs.',
    {
      server_id: z.string().describe('Server identifier'),
      root: z.string().describe('Root directory for the rename operations. Default: "/"').default('/'),
      files: z.array(
        z.object({
          from: z.string().describe('Current file name'),
          to: z.string().describe('New file name'),
        }),
      ).describe('Array of rename operations'),
    },
    async (params) => renameFiles(params),
  );

  server.tool(
    'create_folder',
    'Create a directory on the server.',
    {
      server_id: z.string().describe('Server identifier'),
      path: z.string().describe('Parent directory path. Default: "/"').default('/'),
      name: z.string().describe('Name of the folder to create'),
    },
    async (params) => createFolder(params),
  );

  // ── Backup Management ──────────────────────────────────────────

  server.tool(
    'list_backups',
    'List all backups for a server. Returns UUID, name, size, creation date, completion status, and SHA-256 checksum for each backup.',
    {
      server_id: z.string().describe('Server identifier'),
    },
    async (params) => listBackups(params),
  );

  server.tool(
    'create_backup',
    'Create a full backup of the server. The MCP server handles asynchronous polling internally — this tool blocks until the backup is completed or times out. Returns the backup UUID, size, and checksum upon completion.',
    {
      server_id: z.string().describe('Server identifier'),
      name: z.string().describe("Human-readable backup name (e.g., 'pre-deploy-abc123')"),
      ignored: z.array(z.string()).describe('File paths to exclude from the backup. Default: [] (full backup)').default([]),
      timeout_seconds: z.number().describe('Maximum seconds to wait for backup completion. Default: 600 (10 min)').default(600),
    },
    async (params) => createBackup(params),
  );

  server.tool(
    'get_backup_status',
    'Check the status of a specific backup. Returns whether the backup is processing, completed, or failed, along with size and checksum if completed.',
    {
      server_id: z.string().describe('Server identifier'),
      backup_uuid: z.string().describe('Backup UUID'),
    },
    async (params) => getBackupStatus(params),
  );

  server.tool(
    'restore_backup',
    "Restore a server from a backup. DANGEROUS: This replaces server files. The 'truncate' option (which wipes ALL files before restoring) is especially dangerous and requires separate confirmation. Server must be offline before restoring.",
    {
      server_id: z.string().describe('Server identifier'),
      backup_uuid: z.string().describe('Backup UUID to restore'),
      truncate: z.boolean().describe('If true, wipe ALL server files before restoring. EXTREMELY DANGEROUS. Default: false').default(false),
      confirm: z.boolean().describe('Must be true to execute this dangerous operation').default(false),
      confirm_truncate: z.boolean().describe('Must be true when truncate is true. Double-confirmation for data safety.').default(false),
    },
    async (params) => restoreBackup(params),
  );

  server.tool(
    'delete_backup',
    'Delete a backup for a server. This operation is irreversible. Requires explicit confirmation.',
    {
      server_id: z.string().describe('Server identifier'),
      backup_uuid: z.string().describe('Backup UUID to delete'),
      confirm: z.boolean().describe('Must be true to execute this dangerous operation').default(false),
    },
    async (params) => deleteBackup(params),
  );

  // ── Console Access ─────────────────────────────────────────────

  server.tool(
    'send_command',
    "Send a command to the server console via WebSocket. The command is executed immediately. Use get_console_output to retrieve the response. For power operations, prefer start_server/stop_server/restart_server tools instead.",
    {
      server_id: z.string().describe('Server identifier'),
      command: z.string().describe("Console command to execute (e.g., 'say Hello players', 'list', 'tps')"),
    },
    async (params) => sendCommand(params),
  );

  server.tool(
    'get_player_count',
    "Get the current player count for a Minecraft server. Since the Pterodactyl API does not provide player count directly, this tool sends the 'list' console command, waits for the response, and parses the player count from the output. Returns -1 if the count cannot be determined within 10 seconds.",
    {
      server_id: z.string().describe('Server identifier'),
      timeout_seconds: z.number().describe('Maximum seconds to wait for console response. Default: 10').default(10),
    },
    async (params) => getPlayerCount(params),
  );

  server.tool(
    'get_console_output',
    'Retrieve recent console output for a server. Returns the last N lines from the internal buffer. The buffer is populated by the WebSocket connection and is refreshed in real-time.',
    {
      server_id: z.string().describe('Server identifier'),
      lines: z.number().describe('Number of recent lines to retrieve. Default: 50, Max: 200').default(50),
    },
    async (params) => getConsoleOutput(params),
  );

  // ── Schedule Management ────────────────────────────────────────

  server.tool(
    'list_schedules',
    'List all scheduled tasks for a server.',
    {
      server_id: z.string().describe('Server identifier'),
    },
    async (params) => listSchedules(params),
  );

  server.tool(
    'create_schedule',
    'Create a new scheduled task for a server. Supports cron expressions for timing and task chains (sequences of tasks that run in order).',
    {
      server_id: z.string().describe('Server identifier'),
      name: z.string().describe('Schedule name'),
      minute: z.string().describe('Cron minute field'),
      hour: z.string().describe('Cron hour field'),
      day_of_week: z.string().describe('Cron day of week field').default('*'),
      day_of_month: z.string().describe('Cron day of month field').default('*'),
      active: z.boolean().describe('Whether the schedule is active').default(true),
      only_when_online: z.boolean().describe('Only run when server is online').default(false),
      tasks: z.array(
        z.object({
          action: z.enum(['command', 'power', 'backup']).describe('Task action type'),
          payload: z.string().describe('Command string, power signal, or backup name'),
          time_offset: z.number().describe('Seconds to wait before executing this task (for chaining)').default(0),
          continue_on_failure: z.boolean().describe('Continue to next task if this one fails').default(false),
        }),
      ).describe('Tasks in this schedule'),
    },
    async (params) => createSchedule(params),
  );

  // ── Application-Level Tools ────────────────────────────────────

  server.tool(
    'get_build_config',
    "Get the server's build configuration including allocated resources (CPU, memory, disk, IO) and feature limits. Requires Application API key.",
    {
      server_id: z.string().describe('Server identifier'),
    },
    async (params) => getBuildConfig(params),
  );

  server.tool(
    'update_build_config',
    "Update the server's resource allocations (memory, CPU, disk, IO). This is a server-level configuration change that takes effect on next boot. Requires Application API key and explicit confirmation.",
    {
      server_id: z.string().describe('Server identifier'),
      allocation: z.number().optional().describe('New memory limit in MB'),
      cpu: z.number().optional().describe('New CPU limit in %'),
      disk: z.number().optional().describe('New disk limit in MB'),
      io: z.number().optional().describe('New IO limit (block IO weight, 10-1000)'),
      confirm: z.boolean().describe('Must be true to execute this dangerous operation').default(false),
    },
    async (params) => updateBuildConfig(params),
  );

  server.tool(
    'update_startup',
    'Update server startup command and/or environment variables. Requires Application API key and explicit confirmation.',
    {
      server_id: z.string().describe('Server identifier'),
      startup: z.string().optional().describe('New startup command'),
      environment: z.record(z.string(), z.string()).optional().describe('New environment variables'),
      confirm: z.boolean().describe('Must be true to execute this dangerous operation').default(false),
    },
    async (params) => updateStartup(params),
  );
}
