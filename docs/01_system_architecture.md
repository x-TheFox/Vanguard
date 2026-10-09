# 01 — System Architecture: EdenVanguard (MCP-Centered Revision)

## 1. High-Level Overview

EdenVanguard is a bifurcated system comprising two symbiotic entities and a dedicated MCP tool layer:

- **Vanguard** — The Discord-facing event gateway. It owns all WebSocket listeners, slash-command registrations, modal dispatchers, and message-intercept pipelines. Vanguard is deliberately thin; it routes, validates, and delegates. It does not think.
- **Aegis** — The autonomous intelligence core. Aegis receives structured task payloads from Vanguard, exercises unconstrained executive agency inside its VM sandbox, and streams results back through a well-defined inter-process communication (IPC) channel. Aegis discovers and invokes tools exclusively through the MCP protocol — it never makes direct HTTP calls to Pterodactyl or any external service.
- **Pterodactyl MCP Server** — A standalone MCP server that wraps the Pterodactyl Application API and Client API as schema-defined, discoverable MCP tools. Aegis connects to this server (and other MCP servers) through its MCP client manager, treating Pterodactyl operations as first-class MCP tools indistinguishable from any other tool source.

The three communicate through an **internal message bus** (NATS JetStream) and **MCP protocol** (JSON-RPC over stdio/SSE). This separation ensures:
- Vanguard never touches Pterodactyl or the VM.
- Aegis never speaks Pterodactyl's REST API directly — it only uses MCP tools.
- The Pterodactyl MCP server can be upgraded, replaced, or mocked independently.
- All Pterodactyl credentials, rate-limit management, and auth scoping are centralized in the MCP server.

---

## 2. Architectural Layer Diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          EDENVANGUARD SYSTEM                               │
│                                                                            │
│  ┌──────────────┐                    ┌──────────────────────────────────┐  │
│  │   VANGUARD   │   NATS JetStream   │          AEGIS CORE              │  │
│  │              │◀──────────────────▶│                                  │  │
│  │ Discord.js   │  (IPC Messages)   │  Orchestrator ──▶ Planner         │  │
│  │ Gateway      │                    │       │              │            │  │
│  │ Modals       │                    │       ▼              ▼            │  │
│  │ Buttons      │                    │  Executor ◀─── MCP Client Mgr    │  │
│  │ Threads      │                    │       │         │  │  │          │  │
│  │ Bus Pub/Sub  │                    │       │    ┌────┘  └────┐        │  │
│  └──────────────┘                    │       │    ▼         ▼          │  │
│                                      │  ShellExec  ┌───────────────┐   │  │
│                                      │  SkillEng   │ MCP Servers   │   │  │
│                                      │  Inference  │ (discovered)  │   │  │
│                                      │  Cron       │               │   │  │
│                                      └──────┬──────┤  ┌─────────┐  │   │  │
│                                             │      │  │ Pterodac-│  │   │  │
│                                             │      │  │ tyl MCP  │  │   │  │
│                                             │      │  │ Server   │  │   │  │
│                                             │      │  └────┬────┘  │   │  │
│                                             │      │  ┌────┴────┐  │   │  │
│                                             │      │  │ Filesys  │  │   │  │
│                                             │      │  │ MCP Srv  │  │   │  │
│                                             │      │  └─────────┘  │   │  │
│                                             │      └───────────────┘   │  │
│                                             │                            │  │
│                                      ┌──────┴──────┐                    │  │
│                                      │  SANDBOX     │                    │  │
│                                      │  (Docker VM) │                    │  │
│                                      │  /workspace  │                    │  │
│                                      │  /scripts    │                    │  │
│                                      │  /staging    │                    │  │
│                                      └─────────────┘                    │  │
│                                      └──────────────────────────────────┘  │
│                                                                            │
│  ┌────────────────────┐  ┌─────────────────┐  ┌────────────────────────┐  │
│  │    PostgreSQL       │  │  NATS JetStream  │  │  Pterodactyl MCP Srv  │  │
│  │  api_keys           │  │  (Message Bus)   │  │  (separate process)   │  │
│  │  suggestion_threads │  │                  │  │  ptla_ / ptlc_ keys   │  │
│  │  maintenance_queue  │  │                  │  │  Rate-limit tracker   │  │
│  │  ptero_credentials  │  │                  │  │  WebSocket manager    │  │
│  │  skill_registry     │  │                  │  │  Pagination handler   │  │
│  │  cron_jobs          │  │                  │  │  Credential scoper    │  │
│  └────────────────────┘  └─────────────────┘  └──────────┬─────────────┘  │
│                                                           │                │
└───────────────────────────────────────────────────────────┼────────────────┘
                                    │                       │
                                    │ Discord Gateway (WSS) │ HTTPS + WSS
                                    ▼                       ▼
                              Discord API           Pterodactyl Panel
```

---

## 3. Project File Structure

```
edenvanguard/
├── docs/                              # Blueprint & specification documents
│   ├── 01_system_architecture.md
│   ├── 02_database_schema.sql
│   ├── 03_state_machines.md
│   ├── 04_api_contracts.md
│   ├── 05_feature_expansion.md
│   ├── 06_implementation_phases.md
│   ├── 07_pterodactyl_research.md
│   └── 08_risks_and_limits.md
│
├── vanguard/                           # ── DISCORD INTERFACE LAYER ──
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                    # Bootstrap: Discord.js client, gateway intents
│   │   ├── config/
│   │   │   ├── env.ts                  # Validated env vars
│   │   │   ├── permissions.ts          # Role ID maps, admin hierarchy definitions
│   │   │   └── channels.ts            # Channel/Forum ID registry
│   │   ├── gateway/
│   │   │   ├── messageRouter.ts        # Global message listener & regex pre-filter
│   │   │   ├── crashDetector.ts        # Minecraft crash-signature regex engine
│   │   │   ├── pasteLinkExtractor.ts   # mclogs / pastebin / gnome.dev URL resolver
│   │   │   └── forumWatcher.ts         # Suggestions Forum thread-create listener
│   │   ├── interactions/
│   │   │   ├── commandRegistry.ts      # Slash-command definition & registration
│   │   │   ├── modalDispatcher.ts      # Modal create & submit handlers
│   │   │   ├── buttonHandler.ts        # [Approve & Deploy] / [Reject] button routes
│   │   │   └── checkboxBuilder.ts      # Mod-selection checkbox UI assembly
│   │   ├── threads/
│   │   │   ├── threadManager.ts        # Create / archive / lock Discord threads
│   │   │   ├── diagnosticThread.ts     # Aegis Diagnostic thread scaffolding
│   │   │   └── evaluationThread.ts     # Suggestion evaluation thread scaffolding
│   │   ├── transport/
│   │   │   ├── busPublisher.ts         # Publish task payloads to NATS
│   │   │   ├── busSubscriber.ts        # Subscribe to Aegis result streams
│   │   │   └── schemas/               # Zod schemas for IPC messages
│   │   ├── utils/
│   │   │   ├── logger.ts
│   │   │   ├── rateLimiter.ts
│   │   │   └── discordFormatter.ts
│   │   └── index.ts
│   └── tests/
│
├── aegis/                              # ── AUTONOMOUS INTELLIGENCE CORE ──
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                    # Bootstrap: IPC listener, MCP client, VM provisioner
│   │   ├── core/
│   │   │   ├── orchestrator.ts         # Main loop: receive task → plan → execute → report
│   │   │   ├── planner.ts             # Decompose task into execution steps using MCP tools
│   │   │   ├── executor.ts            # Step-by-step execution engine
│   │   │   ├── evaluator.ts           # Self-assessment: did the step succeed?
│   │   │   └── reporter.ts            # Stream results back through IPC bus
│   │   ├── sandbox/
│   │   │   ├── vmProvisioner.ts       # Create/destroy Docker sandbox containers
│   │   │   ├── shellExec.ts           # child_process.exec wrapper with safety harness
│   │   │   ├── fileBridge.ts          # Bidirectional file copy (host ↔ sandbox)
│   │   │   └── resourceMonitor.ts     # CPU/memory/elapsed-time enforcement
│   │   ├── mcp/                        # ── MCP CLIENT LAYER ──
│   │   │   ├── mcpClientManager.ts    # Discover, connect, invoke MCP servers
│   │   │   ├── transport/
│   │   │   │   ├── stdioTransport.ts  # stdio JSON-RPC transport for local MCP servers
│   │   │   │   └── sseTransport.ts    # SSE HTTP transport for remote MCP servers
│   │   │   ├── toolRegistry.ts        # Unified tool registry (builtin + skill + MCP)
│   │   │   ├── authDelegate.ts        # Delegates credential resolution to MCP servers
│   │   │   └── config/
│   │   │       └── mcpServers.json    # MCP server connection configurations
│   │   ├── skills/
│   │   │   ├── skillEngine.ts         # Skill file discovery, loading, hot-reload
│   │   │   ├── skillRunner.ts         # Execute skill scripts inside sandbox
│   │   │   └── skillManifest.ts       # Tool manifest generator for dynamic skills
│   │   ├── inference/
│   │   │   ├── keyVault.ts            # API key retrieval & rotation (LLM providers)
│   │   │   ├── loadBalancer.ts        # get_next_valid_key() implementation
│   │   │   ├── resilientClient.ts     # 429-aware, auto-retry inference client
│   │   │   └── providers/
│   │   │       ├── groqProvider.ts
│   │   │       └── opencodeProvider.ts
│   │   ├── modding/
│   │   │   ├── modResolver.ts         # CurseForge / Modrinth ID unification
│   │   │   ├── jarDownloader.ts       # Download .jar binaries into sandbox
│   │   │   └── resourceEstimator.ts   # Server resource overhead profiling
│   │   ├── cron/
│   │   │   ├── scheduler.ts           # Cron job registration & management
│   │   │   ├── playerMonitor.ts       # Monitor player count (via MCP ptero tools)
│   │   │   └── deploymentRunner.ts    # Execute staged deployment lifecycle
│   │   └── websearch/
│   │       ├── searchClient.ts        # Web search integration
│   │       └── resultParser.ts        # Extract relevant results
│   ├── skills/                         # ── DYNAMIC SKILL FILE DIRECTORY ──
│   │   ├── README.md
│   │   ├── _template.py
│   │   ├── _template.js
│   │   ├── _template.sh
│   │   └── (Aegis-generated skills)
│   └── tests/
│
├── pterodactyl-mcp/                    # ── PTERODACTYL MCP SERVER ──
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                    # MCP server bootstrap (stdio transport)
│   │   ├── server.ts                   # MCP server implementation (tools/list, tools/call)
│   │   ├── config/
│   │   │   ├── env.ts                  # Panel URL, key configs, rate limit settings
│   │   │   └── toolPermissions.ts      # Permission gates per tool (safe, gated, excluded)
│   │   ├── auth/
│   │   │   ├── credentialStore.ts      # Load/rotate ptla_ and ptlc_ keys from DB
│   │   │   ├── keyScopeResolver.ts     # Determine which key type a tool requires
│   │   │   ├── rateLimitTracker.ts     # Track X-RateLimit-Remaining per key
│   │   │   └── tokenRefresh.ts         # WebSocket JWT refresh loop (8-min interval)
│   │   ├── client/
│   │   │   ├── httpClient.ts           # Rate-limit-aware HTTP client (handles 429, pagination)
│   │   │   ├── websocketClient.ts      # WebSocket lifecycle: connect, auth, refresh, reconnect
│   │   │   └── pagination.ts           # Auto-paginate list endpoints
│   │   ├── tools/                      # ── MCP TOOL IMPLEMENTATIONS ──
│   │   │   ├── serverManagement.ts     # get_server, list_servers, get_resources
│   │   │   ├── powerControl.ts         # start_server, stop_server, restart_server, kill_server
│   │   │   ├── consoleAccess.ts        # send_command, get_console_output, get_player_count
│   │   │   ├── fileManagement.ts       # list_files, read_file, write_file, upload_file, etc.
│   │   │   ├── backupManagement.ts     # list_backups, create_backup, get_backup_status, restore_backup
│   │   │   ├── scheduleManagement.ts   # list_schedules, create_schedule, execute_schedule
│   │   │   └── buildManagement.ts      # get_build_config, update_build_config (gated)
│   │   ├── resources/                  # ── MCP RESOURCE IMPLEMENTATIONS ──
│   │   │   ├── serverStatus.ts         # Real-time server status as MCP resource
│   │   │   ├── consoleStream.ts        # Live console as MCP resource (subscribable)
│   │   │   └── resourceUsage.ts        # Resource stats as MCP resource
│   │   ├── prompts/                    # ── MCP PROMPT IMPLEMENTATIONS ──
│   │   │   ├── deploymentGuide.ts      # Prompt template for deployment procedures
│   │   │   └── diagnosticGuide.ts      # Prompt template for crash diagnostics
│   │   └── utils/
│   │       ├── pathSanitizer.ts        # Prevent directory traversal in file paths
│   │       ├── errorMapper.ts          # Map Pterodactyl errors to MCP error codes
│   │       └── confirmationGate.ts     # Enforce confirm=true on dangerous operations
│   └── tests/
│       ├── unit/
│       ├── integration/
│       └── e2e/
│           ├── pterodactyl_mcp_lifecycle.test.ts
│           └── deployment_sequence.test.ts
│
├── shared/                             # ── CROSS-CUTTING LIBRARIES ──
│   ├── types/
│   │   ├── ipc.ts                      # IPC message envelope types
│   │   ├── tasks.ts                    # Task payload & result types
│   │   ├── models.ts                   # Database model interfaces
│   │   └── pterodactyl.ts             # Pterodactyl API response types
│   ├── db/
│   │   ├── client.ts                   # PostgreSQL connection pool
│   │   ├── migrations/
│   │   └── seeds/
│   └── crypto/
│       └── encrypt.ts                  # AES-256-GCM encryption for tokens
│
├── infra/                              # ── INFRASTRUCTURE AS CODE ──
│   ├── docker/
│   │   ├── docker-compose.yml          # Postgres, Redis, NATS, Vanguard, Aegis, PteroMCP
│   │   ├── Dockerfile.vanguard
│   │   ├── Dockerfile.aegis
│   │   ├── Dockerfile.pterodactyl-mcp  # MCP server container
│   │   └── Dockerfile.sandbox
│   └── scripts/
│       ├── setup.sh
│       └── backup_db.sh
│
├── .env.example
├── .gitignore
└── README.md
```

---

## 4. MCP-Centered Architecture: Key Design Decisions

### 4.1 Pterodactyl as MCP Server, Not REST Client

The original architecture had Aegis directly calling a Pterodactyl REST client (`aegis/src/pterodactyl/`). This is replaced with a **dedicated Pterodactyl MCP Server** process (`pterodactyl-mcp/`). The critical implications are:

| Aspect | Old (Direct REST) | New (MCP Server) |
|---|---|---|
| **Discovery** | Hardcoded method calls | `tools/list` — Aegis discovers available tools at runtime |
| **Schema** | TypeScript interfaces, internal only | JSON Schema via MCP — self-documenting, type-safe |
| **Auth** | Scattered across Aegis modules | Centralized in MCP server's credential store |
| **Rate limiting** | Per-call tracking in Aegis | Centralized rate-limit tracker with key rotation |
| **WebSocket** | Managed inside Aegis | Managed by MCP server; exposed as MCP resources |
| **Pagination** | Aegis must handle it | MCP server auto-paginates; Aegis sees complete results |
| **Async ops** | Aegis polls manually | MCP server polls internally; returns final results |
| **Safety gates** | Ad-hoc checks | `confirmationGate.ts` enforces gates uniformly |
| **Testing** | Must mock Pterodactyl directly | Mock the MCP server (one interface, not many endpoints) |
| **Extensibility** | New endpoints = code changes in Aegis | New tools = register in MCP server; Aegis auto-discovers |

### 4.2 Dual Credential Mode

The Pterodactyl MCP server supports two distinct credential modes, selected automatically based on tool requirements:

- **Application mode** (`ptla_` keys): Used for admin-level operations — listing all servers, managing allocations, reading build configurations. These keys are high-value and their use is minimized.
- **Client mode** (`ptlc_` keys): Used for per-server operations — file management, console access, backups, power control. These keys are scoped to specific user permissions.

The `keyScopeResolver.ts` component determines which mode a tool requires. If a tool can operate in either mode (e.g., `get_server`), Client mode is preferred to minimize Application key exposure.

### 4.3 MCP Resources for Real-Time Data

The Pterodactyl MCP server exposes subscribable MCP resources for real-time data:

- `pterodactyl://servers/{id}/status` — Current power state (running, offline, starting, stopping)
- `pterodactyl://servers/{id}/console` — Live console output stream
- `pterodactyl://servers/{id}/resources` — Periodic resource usage updates (CPU, memory, disk, network)

Aegis subscribes to these resources through the MCP client manager. When a resource updates (e.g., a new console line appears), the MCP server pushes the update to all subscribed clients. This replaces the previous design where Aegis directly managed WebSocket connections.

### 4.4 MCP Prompts for Guided Operations

The Pterodactyl MCP server exposes prompt templates that guide Aegis through complex multi-step operations:

- `pterodactyl_deployment_guide` — Step-by-step deployment procedure with safety checks
- `pterodactyl_diagnostic_guide` — Crash log analysis procedure using console and file tools

These prompts are retrieved via the MCP `prompts/list` and `prompts/get` endpoints. Aegis's planner can use them as templates for constructing execution plans, ensuring that critical safety steps (backup before deploy, TPS validation after restart) are never accidentally omitted.

---

## 5. Component Responsibility Matrix (Revised)

| Component | Owning Entity | Responsibility | Pterodactyl Access |
|---|---|---|---|
| `vanguard/` | Vanguard | Discord I/O, event routing, UI | None — never touches Pterodactyl |
| `aegis/src/core/` | Aegis | Autonomous orchestration loop | None — uses MCP tools only |
| `aegis/src/mcp/` | Aegis | MCP client: discover, connect, invoke | Via MCP protocol to pterodactyl-mcp |
| `aegis/src/sandbox/` | Aegis | VM sandbox lifecycle | None |
| `aegis/src/skills/` | Aegis | Dynamic skill file engine | None — skills use MCP tools |
| `aegis/src/inference/` | Aegis | LLM inference (Groq, OpenCode Zen) | None |
| `aegis/src/modding/` | Aegis | Mod resolution, JAR analysis | None — file ops via MCP tools |
| `aegis/src/cron/` | Aegis | Player monitoring, deployment scheduling | Uses MCP ptero tools |
| `pterodactyl-mcp/` | Standalone | Pterodactyl MCP server | **Full access** — centralized |
| `shared/` | All | Database, types, crypto | None |

---

## 6. Inter-Process Communication Architecture

### 6.1 Communication Channels

| Channel | Protocol | Purpose |
|---|---|---|
| Vanguard ↔ Aegis | NATS JetStream | Task dispatch and result streaming |
| Aegis ↔ Pterodactyl MCP | stdio JSON-RPC | MCP tool invocation (Aegis is MCP client, ptero-mcp is MCP server) |
| Aegis ↔ Filesystem MCP | stdio JSON-RPC | Sandbox file access |
| Aegis ↔ Other MCP Servers | stdio or SSE JSON-RPC | Dynamic tool discovery |
| Pterodactyl MCP ↔ Pterodactyl Panel | HTTPS + WSS | REST API calls and WebSocket console |

### 6.2 MCP Server Configuration

`aegis/src/mcp/config/mcpServers.json`:

```json
{
  "servers": [
    {
      "id": "pterodactyl",
      "transport": "stdio",
      "command": "node",
      "args": ["../../pterodactyl-mcp/dist/index.js"],
      "env": {
        "PTERO_PANEL_URL": "${PTERO_PANEL_URL}",
        "PTERO_APP_KEY_ID": "1",
        "PTERO_CLIENT_KEY_ID": "1"
      },
      "enabled": true,
      "auto_connect": true
    },
    {
      "id": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "enabled": true,
      "auto_connect": true
    }
  ]
}
```

**Key change**: Pterodactyl credentials are no longer in Aegis's environment. Instead, the MCP server references **key IDs** in the database. The MCP server resolves these to actual keys at runtime. This means:
- Aegis never sees raw Pterodactyl API keys.
- Key rotation happens in the MCP server without Aegis restart.
- Different MCP server instances can use different key sets.

---

## 7. Credential Storage & Key Rotation (Revised)

### 7.1 Database Schema Addition

A new table `ptero_credentials` separates Pterodactyl credentials from LLM provider keys. The full DDL, indexes, constraints, and documentation are in `02_database_schema.sql`. The key fields are:

```sql
CREATE TABLE ptero_credentials (
    credential_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    credential_type   ptero_credential_type NOT NULL,  -- 'application' | 'client'
    encrypted_token   TEXT NOT NULL,          -- AES-256-GCM ciphertext (base64)
    token_nonce       TEXT NOT NULL,          -- GCM nonce (base64, 12 bytes)
    token_tag         TEXT NOT NULL,          -- GCM auth tag (base64, 16 bytes)
    token_hash        TEXT NOT NULL UNIQUE,   -- SHA-256 of key prefix (dedup without decrypt)
    description       TEXT,                   -- Human-readable label
    server_scope      JSONB NOT NULL DEFAULT '[]'::JSONB,  -- Server UUIDs (client keys)
    permissions       JSONB NOT NULL DEFAULT '{}'::JSONB,  -- Permission bits
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    rate_limit_remaining INTEGER DEFAULT 240,
    rate_limit_reset_at  TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Key design decisions:**

- **`token_hash`**: A SHA-256 digest of the key prefix (`"ptla_"` / `"ptlc_"` + first 8 chars). This allows the MCP server to detect duplicate key registrations without decrypting every stored token. The UNIQUE constraint prevents the same Pterodactyl key from being registered twice.

- **`server_scope` as JSONB array**: Client keys (`ptlc_`) are scoped to specific server UUIDs. The GIN index on this column enables efficient containment queries like "find all client keys that can access server UUID X." Application keys (`ptla_`) have an empty `server_scope` because they inherently access all servers.

- **`permissions` as JSONB object**: Client keys carry granular subuser permissions (e.g., `control.console`, `file.read`). Application keys carry coarse-grained admin permissions (e.g., `servers: "read"`). The GIN index enables queries like "find a key that has both `backup.create` and `backup.restore` permissions."

- **Dedicated database role**: The `ptero_mcp_app` role has SELECT/INSERT/UPDATE but NO DELETE on `ptero_credentials`, enforcing the policy that inactive keys are retained for audit history.

- **Credential isolation**: Aegis (`aegis_app` role) has NO access to `ptero_credentials`. Only the Pterodactyl MCP server (`ptero_mcp_app` role) can read and update Pterodactyl credentials. This ensures Aegis can never accidentally expose or misuse Pterodactyl API keys.

### 7.2 Key Selection Algorithm

The Pterodactyl MCP server implements its own key rotation:

```
For each tool invocation:
  1. Determine required key_type (application or client) from toolPermissions.ts
  2. If client key required:
     a. Filter ptero_credentials WHERE key_type='client' AND is_active=true AND is_rate_limited=false
     b. If tool targets a specific server, further filter by server_scope containing that server UUID
     c. Select key with highest rate_limit_remaining, breaking ties by least-recent last_used_at
  3. If application key required:
     a. Filter ptero_credentials WHERE key_type='application' AND is_active=true AND is_rate_limited=false
     b. Select key with highest rate_limit_remaining
  4. If no valid key found:
     - Return MCP error: "No available credentials for this operation"
     - Aegis planner should treat this as a transient failure and retry after delay
  5. After API response:
     - Update rate_limit_remaining from X-RateLimit-Remaining header
     - If 429 response: flag key as rate_limited, set rate_limit_reset_at from X-RateLimit-Reset
```

---

## 8. WebSocket Lifecycle Management (MCP-Centered)

The Pterodactyl MCP server owns all WebSocket connections. Aegis never manages WebSockets directly.

### 8.1 Connection Pooling

The MCP server maintains a pool of WebSocket connections:

```typescript
interface WSConnectionPool {
  connections: Map<string, WSConnection>;  // Key: server UUID
  
  getOrConnect(serverId: string): Promise<WSConnection>;
  disconnect(serverId: string): void;
  refreshAll(): Promise<void>;  // Refresh JWT tokens for all active connections
}

interface WSConnection {
  serverId: string;
  socket: WebSocket;
  jwtToken: string;
  jwtExpiry: Date;
  consoleBuffer: string[];  // Circular buffer of last 200 lines
  lastStats: StatsPayload | null;
  lastStatus: string;       // 'running' | 'offline' | 'starting' | 'stopping'
  subscribers: Set<string>; // MCP client IDs subscribed to this server's resources
}
```

### 8.2 JWT Refresh Loop

```
Every 8 minutes (2 min before 10-min expiry):
  FOR EACH active WSConnection:
    1. Call GET /api/client/servers/{id}/websocket with current ptlc_ key
    2. If success:
       - Update jwtToken and jwtExpiry
       - Send new auth message on existing WebSocket: { event: "auth", args: [newToken] }
    3. If failure (401, key revoked):
       - Close WebSocket
       - Attempt reconnection with different ptlc_ key
       - If no valid key: mark connection as disconnected, notify subscribers
```

### 8.3 Resource Subscriptions

When Aegis subscribes to `pterodactyl://servers/{id}/console`:

1. Aegis's MCP client sends a resource subscription request to the Pterodactyl MCP server.
2. The MCP server ensures a WebSocket connection exists for that server (creating one if needed).
3. The MCP server adds Aegis's client ID to the connection's subscriber set.
4. When console output arrives on the WebSocket, the MCP server pushes it as an MCP resource update to all subscribers.
5. When Aegis unsubscribes, the MCP server removes it from the subscriber set. If no subscribers remain, the WebSocket is closed after a 5-minute idle timeout.

---

## 9. Deployment & Runtime Topology (Revised)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        HOST MACHINE                                  │
│                                                                      │
│  ┌────────────┐   ┌────────────┐   ┌────────────┐                  │
│  │  Vanguard   │   │   Aegis    │   │ Pterodactyl│                  │
│  │  Container  │   │  Container │   │ MCP Server │                  │
│  │            │   │            │   │  Container │                  │
│  │ Discord.js │   │ Orchestr.  │   │            │                  │
│  │ Gateway    │   │ MCP Client │◀─▶│ HTTP Client│──▶ Pterodactyl  │
│  │ ModalDisp. │   │ SkillEng.  │std│ WS Manager │    Panel API    │
│  │ BusPub/Sub │   │ ShellExec  │   │ CredStore  │                  │
│  └─────┬──────┘   └─────┬──────┘   └────────────┘                  │
│        │                │                                           │
│        │   NATS         │   Docker API                              │
│        │◀──────────────▶│                                           │
│        │                │          ┌──────────────────────────┐     │
│        │                └─────────▶│  Sandbox (Docker/Fire-   │     │
│        │                           │  cracker microVM)        │     │
│        │                           │  /workspace (volume)     │     │
│        │                           │  /scripts  (volume)      │     │
│        │                           │  /staging  (volume)      │     │
│        │                           └──────────────────────────┘     │
│        │                                                           │
│  ┌─────┴───────────────────────────────────────────────────────┐   │
│  │                    PostgreSQL                                 │   │
│  │  api_keys | ptero_credentials | suggestion_threads           │   │
│  │  maintenance_queue | skill_registry | cron_jobs              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    NATS JetStream                             │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 10. Security Boundaries (Revised)

| Boundary | Mechanism | Rationale |
|---|---|---|
| Vanguard ↔ Pterodactyl | **No connection** | Vanguard never touches game infrastructure |
| Aegis ↔ Pterodactyl | **MCP protocol only** | Aegis can only use MCP tools; never raw API |
| Aegis ↔ Pterodactyl MCP | stdio JSON-RPC | Local process communication; no network exposure |
| Pterodactyl MCP ↔ Pterodactyl Panel | HTTPS + WSS with TLS | Standard API communication |
| Pterodactyl MCP ↔ Database | TLS PostgreSQL | Read ptero_credentials; update rate limit tracking |
| Pterodactyl MCP keys at rest | AES-256-GCM | Keys encrypted in database; decrypted only in MCP server memory |
| Aegis ↔ Sandbox | Docker API with TLS | Sandbox cannot escape to host Aegis process |
| Aegis ↔ Discord | **No connection** | All Discord communication routes through Vanguard |

**Critical security property**: Aegis cannot make arbitrary HTTP requests to the Pterodactyl panel. It can only invoke the MCP tools that the Pterodactyl MCP server chooses to expose. If a tool is excluded (e.g., `delete_server`), Aegis has no way to access that capability.

---

## 11. Configuration & Secrets Management

### Required Environment Variables

```
# ── Vanguard ──
DISCORD_TOKEN=
DISCORD_GUILD_ID=
DISCORD_ADMIN_ROLE_IDS=
DISCORD_SUGGESTIONS_FORUM_ID=
DISCORD_CHANGELOGS_CHANNEL_ID=
NATS_URL=nats://nats:4222
DATABASE_URL=postgresql://edenvanguard:***@postgres:5432/edenvanguard

# ── Aegis ──
NATS_URL=nats://nats:4222
DATABASE_URL=postgresql://edenvanguard:***@postgres:5432/edenvanguard
ENCRYPTION_KEY=                          # 32-byte hex key for AES-256-GCM
SANDBOX_DOCKER_SOCKET=/var/run/docker.sock
SANDBOX_CPU_LIMIT=2
SANDBOX_MEMORY_LIMIT=4g
SANDBOX_TIMEOUT_MS=1800000

# ── Inference (LLM providers) ──
GROQ_API_KEY_1=
GROQ_API_KEY_2=
OPENCODE_ZEN_API_KEY_1=

# ── Pterodactyl MCP Server ──
PTERO_PANEL_URL=https://panel.example.com
PTERO_DB_CREDENTIAL_IDS=                 # Comma-separated DB IDs for initial keys
PTERO_WS_IDLE_TIMEOUT_MS=300000          # Close idle WebSocket after 5 min
PTERO_WS_JWT_REFRESH_INTERVAL_MS=480000 # Refresh JWT at 8 min
PTERO_BACKUP_POLL_INTERVAL_MS=5000       # Poll backup status every 5s
PTERO_BACKUP_POLL_TIMEOUT_MS=600000      # Max 10 min wait for backup completion
```

**Note**: Raw Pterodactyl API keys (`ptla_...`, `ptlc_...`) are NOT in environment variables. They are stored encrypted in the `ptero_credentials` database table and loaded at runtime by the MCP server.
