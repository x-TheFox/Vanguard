# 04 — API Contract Definitions (MCP-Centered Revision)

This document defines the exact MCP tool, resource, and prompt interfaces exposed by the Pterodactyl MCP Server, the shell execution contract, and the unified tool invocation interface. All Pterodactyl operations are now exposed exclusively through MCP — Aegis never calls Pterodactyl REST endpoints directly.

---

## 1. Pterodactyl MCP Server — Tool Definitions

All tools follow the MCP `tools/call` protocol. Each tool definition includes its JSON Schema input, output structure, required credential mode, permission gate level, and safety constraints.

### 1.1 Server Management Tools

#### `list_servers`

List all servers accessible to the configured credentials.

| Property | Value |
|---|---|
| Credential mode | Application (preferred) or Client |
| Permission gate | Safe |
| Auto-pagination | Yes (returns all pages) |

```json
{
  "name": "list_servers",
  "description": "List all servers accessible via the configured Pterodactyl credentials. Returns complete server details including UUID, name, node, and resource allocations. Automatically paginates through all results.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "filter_name": {
        "type": "string",
        "description": "Optional: filter servers by name (substring match)"
      }
    }
  }
}
```

**Output**:
```json
{
  "content": [{
    "type": "text",
    "text": "[{\"uuid\":\"abc123\",\"name\":\"Survival Main\",\"node\":\"Node-1\",\"allocation\":{...},\"limits\":{\"memory\":1024,\"cpu\":200},...}]"
  }]
}
```

---

#### `get_server`

Get detailed information about a specific server.

| Property | Value |
|---|---|
| Credential mode | Application or Client |
| Permission gate | Safe |

```json
{
  "name": "get_server",
  "description": "Get detailed information about a specific Pterodactyl server including UUID, name, node, allocation, limits, container, and startup configuration.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": {
        "type": "string",
        "description": "Server identifier (UUID or short ID)"
      }
    },
    "required": ["server_id"]
  }
}
```

---

#### `get_server_resources`

Get current resource usage for a server.

| Property | Value |
|---|---|
| Credential mode | Client |
| Permission gate | Safe |

```json
{
  "name": "get_server_resources",
  "description": "Get current resource usage for a server including CPU percentage, memory bytes, disk bytes, and network I/O. Also returns the current power state. Note: player count is NOT included — use get_player_count tool instead.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": {
        "type": "string",
        "description": "Server identifier (UUID or short ID)"
      }
    },
    "required": ["server_id"]
  }
}
```

**Output**:
```json
{
  "content": [{
    "type": "text",
    "text": "{\"current_state\":\"running\",\"memory_bytes\":134217728,\"memory_limit_bytes\":1073741824,\"cpu_absolute\":2.5,\"disk_bytes\":50331648,\"network\":{\"rx_bytes\":1024,\"tx_bytes\":2048}}"
  }]
}
```

---

### 1.2 Power Control Tools

#### `start_server`

| Property | Value |
|---|---|
| Credential mode | Client |
| Permission gate | Safe |
| Pterodactyl endpoint | `POST /api/client/servers/{id}/power` body: `{"signal":"start"}` |

```json
{
  "name": "start_server",
  "description": "Send a start signal to the server. If the server is already running, this is a no-op. If it is starting or stopping, the signal is queued.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": {
        "type": "string",
        "description": "Server identifier"
      }
    },
    "required": ["server_id"]
  }
}
```

---

#### `stop_server`

| Property | Value |
|---|---|
| Credential mode | Client |
| Permission gate | Safe |
| Pterodactyl endpoint | `POST /api/client/servers/{id}/power` body: `{"signal":"stop"}` |

```json
{
  "name": "stop_server",
  "description": "Send a graceful stop signal to the server. The server process receives a stop command and is given time to shut down cleanly. If the server does not stop within the configured timeout, use kill_server.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": {
        "type": "string",
        "description": "Server identifier"
      },
      "grace_period_seconds": {
        "type": "integer",
        "description": "Seconds to wait for graceful shutdown before reporting timeout. Default: 60",
        "default": 60
      }
    },
    "required": ["server_id"]
  }
}
```

---

#### `restart_server`

| Property | Value |
|---|---|
| Credential mode | Client |
| Permission gate | Safe |
| Pterodactyl endpoint | `POST /api/client/servers/{id}/power` body: `{"signal":"restart"}` |

```json
{
  "name": "restart_server",
  "description": "Send a restart signal to the server. This performs a graceful stop followed by an automatic start.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": {
        "type": "string",
        "description": "Server identifier"
      }
    },
    "required": ["server_id"]
  }
}
```

---

#### `kill_server`

| Property | Value |
|---|---|
| Credential mode | Client |
| Permission gate | **Gated** — requires `confirm: true` |
| Pterodactyl endpoint | `POST /api/client/servers/{id}/power` body: `{"signal":"kill"}` |

```json
{
  "name": "kill_server",
  "description": "Force-kill the server process immediately. This is destructive and may cause data loss. Use only when graceful stop fails. Requires explicit confirmation.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": {
        "type": "string",
        "description": "Server identifier"
      },
      "confirm": {
        "type": "boolean",
        "description": "Must be true to execute this dangerous operation",
        "default": false
      }
    },
    "required": ["server_id", "confirm"]
  }
}
```

**Error when confirm is false**: The tool returns an MCP error with code `-32001` and message `"Confirmation required: set confirm=true to execute this dangerous operation"`.

---

### 1.3 Console Access Tools

#### `send_command`

| Property | Value |
|---|---|
| Credential mode | Client (WebSocket) |
| Permission gate | Safe (commands are logged) |

```json
{
  "name": "send_command",
  "description": "Send a command to the server console via WebSocket. The command is executed immediately. Use get_console_output to retrieve the response. For power operations, prefer start_server/stop_server/restart_server tools instead.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": {
        "type": "string",
        "description": "Server identifier"
      },
      "command": {
        "type": "string",
        "description": "Console command to execute (e.g., 'say Hello players', 'list', 'tps')"
      }
    },
    "required": ["server_id", "command"]
  }
}
```

---

#### `get_console_output`

| Property | Value |
|---|---|
| Credential mode | Client (WebSocket) |
| Permission gate | Safe |

```json
{
  "name": "get_console_output",
  "description": "Retrieve recent console output for a server. Returns the last N lines from the internal buffer. The buffer is populated by the WebSocket connection and is refreshed in real-time.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": {
        "type": "string",
        "description": "Server identifier"
      },
      "lines": {
        "type": "integer",
        "description": "Number of recent lines to retrieve. Default: 50, Max: 200",
        "default": 50
      }
    },
    "required": ["server_id"]
  }
}
```

---

#### `get_player_count`

| Property | Value |
|---|---|
| Credential mode | Client (WebSocket) |
| Permission gate | Safe |
| Implementation | Composite: sends `list` command, parses console output |

```json
{
  "name": "get_player_count",
  "description": "Get the current player count for a Minecraft server. Since the Pterodactyl API does not provide player count directly, this tool sends the 'list' console command, waits for the response, and parses the player count from the output. Returns -1 if the count cannot be determined within 10 seconds.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": {
        "type": "string",
        "description": "Server identifier"
      },
      "timeout_seconds": {
        "type": "integer",
        "description": "Maximum seconds to wait for console response. Default: 10",
        "default": 10
      }
    },
    "required": ["server_id"]
  }
}
```

**Output**:
```json
{
  "content": [{
    "type": "text",
    "text": "{\"player_count\":5,\"max_players\":20,\"players\":[\"Steve\",\"Alex\",\"Notch\"],\"raw_output\":\"There are 5 of a max of 20 players online: Steve, Alex, Notch\"}"
  }]
}
```

---

### 1.4 File Management Tools

#### `list_files`

| Property | Value |
|---|---|
| Credential mode | Client |
| Permission gate | Safe |
| Auto-pagination | N/A (single directory listing) |

```json
{
  "name": "list_files",
  "description": "List the contents of a directory on the server. Returns file names, sizes, modification dates, and whether each entry is a file or directory. Paths are relative to the server root.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string", "description": "Server identifier" },
      "directory": { "type": "string", "description": "Directory path relative to server root. Default: '/'", "default": "/" }
    },
    "required": ["server_id"]
  }
}
```

---

#### `read_file`

| Property | Value |
|---|---|
| Credential mode | Client |
| Permission gate | Safe |

```json
{
  "name": "read_file",
  "description": "Read the contents of a file from the server. Returns the raw text content. For binary files, use download_file instead. Files larger than 1MB are truncated with a warning.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string", "description": "Server identifier" },
      "file_path": { "type": "string", "description": "File path relative to server root (e.g., '/mods/alex-mobs.jar')" }
    },
    "required": ["server_id", "file_path"]
  }
}
```

---

#### `write_file`

| Property | Value |
|---|---|
| Credential mode | Client |
| Permission gate | Safe (files are logged) |

```json
{
  "name": "write_file",
  "description": "Write content to a file on the server. Creates the file if it does not exist. Overwrites the file if it does exist. Path traversal attempts (..) are rejected. Maximum content size: 5MB.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string", "description": "Server identifier" },
      "file_path": { "type": "string", "description": "Target file path relative to server root" },
      "content": { "type": "string", "description": "File content to write" }
    },
    "required": ["server_id", "file_path", "content"]
  }
}
```

---

#### `upload_file`

| Property | Value |
|---|---|
| Credential mode | Client |
| Permission gate | Safe |
| Implementation | Two-step: get signed URL, then PUT file data |

```json
{
  "name": "upload_file",
  "description": "Upload a file to the server. The file content is provided as base64-encoded data. The MCP server handles the two-step Pterodactyl upload process internally (obtain signed URL, then PUT data). Maximum file size: 100MB.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string", "description": "Server identifier" },
      "target_path": { "type": "string", "description": "Target file path on the server" },
      "file_data_base64": { "type": "string", "description": "Base64-encoded file content" },
      "file_size_bytes": { "type": "integer", "description": "Size of the decoded file in bytes (for validation)" }
    },
    "required": ["server_id", "target_path", "file_data_base64", "file_size_bytes"]
  }
}
```

---

#### `rename_files`

| Property | Value |
|---|---|
| Credential mode | Client |
| Permission gate | Safe |

```json
{
  "name": "rename_files",
  "description": "Rename or move files on the server. Accepts an array of {from, to} pairs.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string", "description": "Server identifier" },
      "root": { "type": "string", "description": "Root directory for the rename operations. Default: '/'", "default": "/" },
      "files": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "from": { "type": "string" },
            "to": { "type": "string" }
          },
          "required": ["from", "to"]
        },
        "description": "Array of rename operations"
      }
    },
    "required": ["server_id", "files"]
  }
}
```

---

#### `delete_files`

| Property | Value |
|---|---|
| Credential mode | Client |
| Permission gate | **Gated** — requires `confirm: true` |

```json
{
  "name": "delete_files",
  "description": "Delete files or directories on the server. This operation is irreversible. Requires explicit confirmation. Path traversal attempts are rejected.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string", "description": "Server identifier" },
      "root": { "type": "string", "description": "Root directory. Default: '/'", "default": "/" },
      "files": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Array of file paths to delete"
      },
      "confirm": {
        "type": "boolean",
        "description": "Must be true to execute this dangerous operation",
        "default": false
      }
    },
    "required": ["server_id", "files", "confirm"]
  }
}
```

---

### 1.5 Backup Management Tools

#### `list_backups`

```json
{
  "name": "list_backups",
  "description": "List all backups for a server. Returns UUID, name, size, creation date, completion status, and SHA-256 checksum for each backup.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string", "description": "Server identifier" }
    },
    "required": ["server_id"]
  }
}
```

---

#### `create_backup`

| Property | Value |
|---|---|
| Credential mode | Client |
| Permission gate | Safe |
| Async handling | Polls until backup completes (up to 10 min) |

```json
{
  "name": "create_backup",
  "description": "Create a full backup of the server. The MCP server handles asynchronous polling internally — this tool blocks until the backup is completed or times out. Returns the backup UUID, size, and checksum upon completion.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string", "description": "Server identifier" },
      "name": { "type": "string", "description": "Human-readable backup name (e.g., 'pre-deploy-abc123')" },
      "ignored": {
        "type": "array",
        "items": { "type": "string" },
        "description": "File paths to exclude from the backup. Default: [] (full backup)",
        "default": []
      },
      "timeout_seconds": {
        "type": "integer",
        "description": "Maximum seconds to wait for backup completion. Default: 600 (10 min)",
        "default": 600
      }
    },
    "required": ["server_id", "name"]
  }
}
```

---

#### `get_backup_status`

```json
{
  "name": "get_backup_status",
  "description": "Check the status of a specific backup. Returns whether the backup is processing, completed, or failed, along with size and checksum if completed.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string" },
      "backup_uuid": { "type": "string", "description": "Backup UUID" }
    },
    "required": ["server_id", "backup_uuid"]
  }
}
```

---

#### `restore_backup`

| Property | Value |
|---|---|
| Credential mode | Client |
| Permission gate | **Gated** — requires `confirm: true` |
| Safety constraint | `truncate` defaults to `false` and requires separate explicit flag |

```json
{
  "name": "restore_backup",
  "description": "Restore a server from a backup. DANGEROUS: This replaces server files. The 'truncate' option (which wipes ALL files before restoring) is especially dangerous and requires separate confirmation. Server must be offline before restoring.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string" },
      "backup_uuid": { "type": "string", "description": "Backup UUID to restore" },
      "truncate": {
        "type": "boolean",
        "description": "If true, wipe ALL server files before restoring. EXTREMELY DANGEROUS. Default: false",
        "default": false
      },
      "confirm": {
        "type": "boolean",
        "description": "Must be true to execute this dangerous operation",
        "default": false
      }
    },
    "required": ["server_id", "backup_uuid", "confirm"]
  }
}
```

**Additional safety**: If `truncate: true` is specified, the tool requires BOTH `confirm: true` AND an additional `confirm_truncate: true` parameter (not shown in schema for clarity — implemented in `confirmationGate.ts`). This double-confirmation prevents accidental data loss.

---

### 1.6 Schedule Management Tools

#### `list_schedules`

```json
{
  "name": "list_schedules",
  "description": "List all scheduled tasks for a server.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string" }
    },
    "required": ["server_id"]
  }
}
```

---

#### `create_schedule`

```json
{
  "name": "create_schedule",
  "description": "Create a new scheduled task for a server. Supports cron expressions for timing and task chains (sequences of tasks that run in order).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string" },
      "name": { "type": "string", "description": "Schedule name" },
      "minute": { "type": "string", "description": "Cron minute field" },
      "hour": { "type": "string", "description": "Cron hour field" },
      "day_of_week": { "type": "string", "description": "Cron day of week field" },
      "day_of_month": { "type": "string", "description": "Cron day of month field" },
      "active": { "type": "boolean", "default": true },
      "only_when_online": { "type": "boolean", "default": false },
      "tasks": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "action": { "type": "string", "enum": ["command", "power", "backup"] },
            "payload": { "type": "string", "description": "Command string, power signal, or backup name" },
            "time_offset": { "type": "integer", "description": "Seconds to wait before executing this task (for chaining)" },
            "continue_on_failure": { "type": "boolean", "default": false }
          },
          "required": ["action", "payload"]
        },
        "description": "Tasks in this schedule"
      }
    },
    "required": ["server_id", "name", "minute", "hour", "tasks"]
  }
}
```

---

#### `execute_schedule`

```json
{
  "name": "execute_schedule",
  "description": "Manually trigger a scheduled task to run immediately, regardless of its cron schedule.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string" },
      "schedule_id": { "type": "integer", "description": "Schedule ID to execute" }
    },
    "required": ["server_id", "schedule_id"]
  }
}
```

---

### 1.7 Build Management Tools (Gated)

#### `get_build_config`

| Property | Value |
|---|---|
| Credential mode | Application |
| Permission gate | Safe |

```json
{
  "name": "get_build_config",
  "description": "Get the server's build configuration including allocated resources (CPU, memory, disk, IO) and feature limits. Requires Application API key.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string" }
    },
    "required": ["server_id"]
  }
}
```

---

#### `update_build_config`

| Property | Value |
|---|---|
| Credential mode | Application |
| Permission gate | **Gated** — requires `confirm: true` |

```json
{
  "name": "update_build_config",
  "description": "Update the server's resource allocations (memory, CPU, disk, IO). This is a server-level configuration change that takes effect on next boot. Requires Application API key and explicit confirmation.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string" },
      "allocation": { "type": "integer", "description": "New memory limit in MB" },
      "cpu": { "type": "integer", "description": "New CPU limit in %" },
      "disk": { "type": "integer", "description": "New disk limit in MB" },
      "io": { "type": "integer", "description": "New IO limit (block IO weight, 10-1000)" },
      "confirm": { "type": "boolean", "default": false }
    },
    "required": ["server_id", "confirm"]
  }
}
```

---

## 2. Pterodactyl MCP Server — Resource Definitions

### 2.1 `pterodactyl://servers/{id}/status`

A subscribable MCP resource that pushes power state changes.

**Subscribe**:
```json
{
  "method": "resources/subscribe",
  "params": { "uri": "pterodactyl://servers/abc123/status" }
}
```

**Update event**:
```json
{
  "method": "notifications/resources/updated",
  "params": {
    "uri": "pterodactyl://servers/abc123/status",
    "value": "running"
  }
}
```

Possible values: `"running"`, `"starting"`, `"stopping"`, `"offline"`.

### 2.2 `pterodactyl://servers/{id}/console`

A subscribable MCP resource that pushes console output lines in real-time.

**Update event**:
```json
{
  "method": "notifications/resources/updated",
  "params": {
    "uri": "pterodactyl://servers/abc123/console",
    "value": "[10:30:45] [Server thread/INFO]: Starting minecraft server version 1.20.1"
  }
}
```

### 2.3 `pterodactyl://servers/{id}/resources`

A subscribable MCP resource that pushes periodic resource usage stats (~15s interval).

**Update event**:
```json
{
  "method": "notifications/resources/updated",
  "params": {
    "uri": "pterodactyl://servers/abc123/resources",
    "value": "{\"memory_bytes\":134217728,\"memory_limit_bytes\":1073741824,\"cpu_absolute\":2.5,\"disk_bytes\":50331648}"
  }
}
```

---

## 3. Pterodactyl MCP Server — Prompt Definitions

### 3.1 `pterodactyl_deployment_guide`

```json
{
  "name": "pterodactyl_deployment_guide",
  "description": "Step-by-step guide for deploying mods or configuration changes to a Pterodactyl-managed Minecraft server. Includes safety checks, backup procedures, and rollback instructions.",
  "arguments": [
    { "name": "server_id", "description": "Target server UUID", "required": true },
    { "name": "mod_names", "description": "Comma-separated list of mod names being deployed", "required": false }
  ]
}
```

### 3.2 `pterodactyl_diagnostic_guide`

```json
{
  "name": "pterodactyl_diagnostic_guide",
  "description": "Guide for diagnosing Minecraft server crashes using Pterodactyl console access, file inspection, and log analysis tools.",
  "arguments": [
    { "name": "server_id", "description": "Target server UUID", "required": true },
    { "name": "crash_type", "description": "Type of crash (OOM, mixin_conflict, ticking_entity, etc.)", "required": false }
  ]
}
```

---

## 4. Shell Execution Contract (Unchanged from Original)

The shell execution contract remains as defined in the original `04_api_contracts.md` Section 1. Aegis continues to use `child_process.exec` inside its sandbox for local operations. The key difference is that Pterodactyl operations no longer appear here — they are exclusively MCP tools.

Refer to the original document for:
- `ShellExecConfig` interface
- `ShellExecResult` interface
- Execution flow
- Safety constraints
- Audit logging schema

---

## 5. MCP Client Contract (Enhanced)

### 5.1 MCP Server Configuration

```typescript
interface MCPServerConfig {
  id: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auto_connect?: boolean;
  enabled?: boolean;
  invocation_timeout?: number;    // Default: 60000
  connection_timeout?: number;    // Default: 10000
}
```

### 5.2 Tool Registry Entry

```typescript
interface ToolRegistryEntry {
  id: string;                     // "pterodactyl::create_backup"
  source: 'builtin' | 'skill_file' | 'mcp';
  mcp_server_id?: string;         // "pterodactyl"
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  invoke: (params: Record<string, unknown>) => Promise<ToolResult>;
  isAvailable: boolean;
  permissionGate: 'safe' | 'gated' | 'excluded';
  credentialMode: 'application' | 'client' | 'either';
  lastInvokedAt?: Date;
  invocationCount: number;
}
```

### 5.3 MCP Error Codes

The Pterodactyl MCP server defines custom error codes for common failure modes:

| Code | Meaning | Recovery |
|---|---|---|
| `-32001` | Confirmation required | Set `confirm: true` and retry |
| `-32002` | Insufficient permissions | Use different credentials or escalate to admin |
| `-32003` | Rate limit reached | Wait and retry (server handles key rotation automatically) |
| `-32004` | Server not found | Verify server_id |
| `-32005` | Invalid server state | Check server power state; operation may require server to be offline |
| `-32006` | Backup slot limit reached | Delete old backups before creating new ones |
| `-32007` | File too large | Use chunked upload or reduce file size |
| `-32008` | No available credentials | Add new API keys to the ptero_credentials table |
| `-32009` | WebSocket unavailable | Server may be offline or connection failed; retry |
| `-32010` | Async operation timed out | Backup or startup took too long; check server manually |

---

## 6. Unified Tool Invocation Interface (Revised)

All tool categories (shell, Pterodactyl MCP, other MCP, skills) are surfaced to Aegis's orchestrator through the same unified interface:

```typescript
interface UnifiedTool {
  id: string;
  category: 'shell' | 'pterodactyl_mcp' | 'mcp' | 'skill';
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute: (params: Record<string, unknown>, context: ExecutionContext) => Promise<ToolResult>;
  estimateRisk: (params: Record<string, unknown>) => number;
  requiresConfirmation: boolean;       // Derived from permissionGate
  credentialMode?: 'application' | 'client' | 'either';  // Pterodactyl-specific
}
```

### Risk Estimation Matrix (Revised)

| Tool Category | Base Risk | Elevated Conditions |
|---|---|---|
| Pterodactyl: read operations (list, get, status) | 0.1 | — |
| Pterodactyl: console commands | 0.3 | Destructive commands (stop, op): 0.6 |
| Pterodactyl: write files | 0.5 | Writing to `mods/` or `config/`: 0.7 |
| Pterodactyl: power start/restart | 0.4 | Restart with players online: 0.7 |
| Pterodactyl: power kill | 0.9 | — |
| Pterodactyl: backup create | 0.2 | — |
| Pterodactyl: backup restore (no truncate) | 0.7 | — |
| Pterodactyl: backup restore (truncate) | 1.0 | Always requires admin confirmation |
| Pterodactyl: delete files | 0.8 | Deleting from `mods/` or `config/`: 0.9 |
| Pterodactyl: build config update | 0.6 | — |
| Shell: read-only | 0.1 | — |
| Shell: write | 0.5 | — |
| Shell: network | 0.3 | — |
| Other MCP: read | 0.1 | — |
| Other MCP: write | 0.5 | — |
| Skill: analysis | 0.2 | — |
| Skill: modification | 0.6 | — |

---

## 7. Error Handling & Recovery (Revised)

### 7.1 Pterodactyl-Specific Error Recovery

```typescript
const PTERO_RECOVERY_STRATEGIES: Record<number, RecoveryAction> = {
  [-32001]: {  // Confirmation required
    action: 'escalate_to_admin',
    message: 'This operation requires admin confirmation. Requesting approval...'
  },
  [-32002]: {  // Insufficient permissions
    action: 'try_alternative_key',
    fallback: 'escalate_to_admin'
  },
  [-32003]: {  // Rate limit
    action: 'wait_and_retry',
    delay_ms: 5000,
    max_retries: 3,
    fallback: 'rotate_key'
  },
  [-32005]: {  // Invalid server state
    action: 'wait_for_state_change',
    timeout_ms: 120000,
    fallback: 'escalate_to_admin'
  },
  [-32008]: {  // No available credentials
    action: 'escalate_to_admin',
    message: 'All Pterodactyl API keys are exhausted or inactive. Admin intervention required.'
  },
  [-32009]: {  // WebSocket unavailable
    action: 'retry_with_backoff',
    max_retries: 5,
    base_delay_ms: 3000,
    fallback: 'use_rest_fallback'
  },
  [-32010]: {  // Async timeout
    action: 'check_and_report',
    message: 'Operation timed out but may still be in progress. Manual verification recommended.'
  }
};
```

### 7.2 Circuit Breaker (Pterodactyl MCP)

The Aegis MCP client implements a circuit breaker per MCP server:

```typescript
interface MCPCircuitBreaker {
  serverId: string;
  failureCount: number;
  failureThreshold: number;    // Default: 5
  resetTimeoutMs: number;      // Default: 30000
  state: 'closed' | 'open' | 'half_open';
  lastFailureAt: Date | null;

  // When open: all invocations fail fast with "circuit open" error
  // When half_open: one probe invocation is allowed; success closes, failure reopens
  // When closed: normal operation
}
```

When the Pterodactyl MCP circuit breaker opens:
1. All Pterodactyl tools are marked `isAvailable: false` in the tool registry.
2. Aegis's planner is notified and attempts alternative routes (e.g., using shell commands to achieve the same result, or deferring the operation).
3. An admin alert is published via the IPC bus to Vanguard.
4. After `resetTimeoutMs`, the circuit enters half-open and a single probe invocation is attempted.
