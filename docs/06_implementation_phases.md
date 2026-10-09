# 06 — Implementation Phases (MCP-Centered Revision)

This document breaks down the coding execution into strict chronological phases, redesigned around the MCP-centered architecture where Pterodactyl is a first-class MCP server rather than a direct REST client within Aegis.

---

## Phase 0: Project Scaffolding, Git Bootstrap & Infrastructure

**Duration Estimate:** 4-5 days  
**Dependencies:** None

### Objectives

Initialize the Git repository with proper branch protection, commit standards, and development workflow. Establish the monorepo structure, Docker infrastructure, database connectivity, IPC message bus, and the Pterodactyl MCP server skeleton.

### Checklist

- [ ] **Git Repository Initialization**
  - [ ] Initialize Git repository with `git init`
  - [ ] Create `.gitignore` with mandatory entries (node_modules, .env, secrets, build artifacts, patches, encryption keys — see `09_development_workflow.md` Section A.3)
  - [ ] Configure Git user settings: `git config user.name` and `git config user.email`
  - [ ] Set up branch strategy: create `main` and `develop` branches from initial commit
  - [ ] Configure branch protection rules on `main` (require PR, require CI pass, no force push, require signed commits)
  - [ ] Configure branch protection rules on `develop` (require CI pass, no force push, require signed commits)
  - [ ] Create initial commit on `main`: `chore: initialize monorepo structure`
  - [ ] Create `develop` branch from `main`
- [ ] **Commit Discipline Setup**
  - [ ] Add `husky` for Git hooks (pre-commit, commit-msg)
  - [ ] Add `lint-staged` configuration for ESLint and Prettier on staged files
  - [ ] Add secret detection pre-commit hook (scan for `ptla_`, `ptlc_`, `sk-`, `xai-`, `gsk_`, `ENCRYPTION_KEY` patterns)
  - [ ] Add `commitlint` with Conventional Commits configuration
  - [ ] Document commit standards in repository (reference `09_development_workflow.md` Section B)
- [ ] **Code Style Enforcement**
  - [ ] Configure ESLint with `@typescript-eslint/recommended` + strict rules at root level
  - [ ] Configure Prettier with project-standard settings (4-space indent, single quotes, trailing commas)
  - [ ] Add `.prettierrc` and `.eslintrc.js` at monorepo root
  - [ ] Add import ordering rule via `eslint-plugin-import`
  - [ ] Verify lint-staged runs on `git commit`
- [ ] **Patch Export Workflow Setup**
  - [ ] Create `patches/` directory (gitignored)
  - [ ] Create `infra/scripts/generate-patches.sh` script (wraps `git format-patch`)
  - [ ] Create `infra/scripts/verify-patches.sh` script (replays patches on fresh repo, runs tests)
  - [ ] Document patch export process (reference `09_development_workflow.md` Section C)
- [ ] **Monorepo Structure**
  - [ ] Create the monorepo directory structure as defined in `01_system_architecture.md` (revised)
  - [ ] Create `package.json` for `vanguard/`, `aegis/`, and `pterodactyl-mcp/` with TypeScript, ESLint, Prettier, Jest
  - [ ] Create `tsconfig.json` for each package with strict mode and path aliases
  - [ ] Create `shared/` package with type definitions (`ipc.ts`, `tasks.ts`, `models.ts`, `pterodactyl.ts`)
  - [ ] Create `shared/db/client.ts` — PostgreSQL connection pool
  - [ ] Create `shared/crypto/encrypt.ts` — AES-256-GCM encryption/decryption
  - [ ] Create `.env.example` with all required environment variables
  - [ ] Create `infra/docker/docker-compose.yml` with services:
  - `postgres` — PostgreSQL 16
  - `nats` — NATS JetStream
  - `vanguard` — Node.js container
  - `aegis` — Node.js container
  - `pterodactyl-mcp` — Node.js container (MCP server)
  - `sandbox` — Docker-in-Docker base image
  - [ ] Create `Dockerfile.pterodactyl-mcp` — Lightweight Node.js image for the MCP server
  - [ ] Create `infra/scripts/setup.sh` — One-command dev bootstrap
  - [ ] Run database migrations from `02_database_schema.sql` (including `ptero_credentials` table with all indexes, constraints, triggers, and the `ptero_mcp_app` role)
  - [ ] Verify all containers start and health-checks pass
  - [ ] Verify Vanguard, Aegis, and Pterodactyl MCP can each connect to PostgreSQL
  - [ ] Verify Pterodactyl MCP can read from `ptero_credentials` using `ptero_mcp_app` role
  - [ ] Verify Aegis cannot read `ptero_credentials` (permission denied expected)

### Testing

- [ ] **Unit:** `shared/crypto/encrypt.test.ts` — AES-256-GCM round-trip, tamper detection
- [ ] **Unit:** `shared/db/client.test.ts` — Connection pool, query execution
- [ ] **Integration:** Vanguard → NATS → Aegis ping-pong test
- [ ] **Integration:** All three services read/write from PostgreSQL
- [ ] **Integration:** Verify `ptero_mcp_app` role can CRUD `ptero_credentials` but not `api_keys`
- [ ] **Integration:** Verify `aegis_app` role can CRUD `api_keys` but not `ptero_credentials`
- [ ] **Workflow:** Commit a test file, verify lint-staged runs, verify commit message validation works
- [ ] **Workflow:** Generate a patch series, replay on fresh repo, verify tests pass

---

## Phase 1: Pterodactyl MCP Server — Core & Auth

**Duration Estimate:** 1.5 weeks  
**Dependencies:** Phase 0 complete

### Objectives

Build the Pterodactyl MCP server skeleton with MCP protocol support (tools/list, tools/call), the dual-credential auth layer, the rate-limit-aware HTTP client, and the WebSocket client with JWT refresh. By the end of this phase, the MCP server should be able to connect to a real Pterodactyl panel and execute basic operations.

### Checklist

- [ ] Create `pterodactyl-mcp/src/index.ts` — MCP server bootstrap with stdio transport
- [ ] Create `pterodactyl-mcp/src/server.ts` — MCP server implementation
  - `initialize` handler: return server capabilities
  - `tools/list` handler: return all registered tool definitions
  - `tools/call` handler: dispatch to tool implementation
  - `resources/list` handler: return subscribable resource URIs
  - `resources/subscribe` / `resources/unsubscribe` handlers
  - `prompts/list` / `prompts/get` handlers
- [ ] Create `pterodactyl-mcp/src/config/env.ts` — Validated env vars (PTERO_PANEL_URL, etc.)
- [ ] Create `pterodactyl-mcp/src/config/toolPermissions.ts` — Permission gate classification per tool:
  - `safe`: No confirmation needed (read operations, start, restart)
  - `gated`: Requires `confirm: true` (kill, delete, restore, build config update)
  - `excluded`: Not exposed as MCP tool (user CRUD, server delete, allocation management)
- [ ] Create `pterodactyl-mcp/src/auth/credentialStore.ts`:
  - Load `ptla_` and `ptlc_` keys from `ptero_credentials` database table
  - Decrypt tokens using `shared/crypto/encrypt.ts`
  - Cache decrypted tokens in memory (never log or expose)
  - Support runtime key addition/removal (reload from DB on signal)
- [ ] Create `pterodactyl-mcp/src/auth/keyScopeResolver.ts`:
  - Map each tool name to required key type (application or client)
  - For tools targeting specific servers, filter by `server_scope` on client keys
  - Return the selected credential for the current invocation
- [ ] Create `pterodactyl-mcp/src/auth/rateLimitTracker.ts`:
  - Track `X-RateLimit-Remaining` and `X-RateLimit-Reset` per key
  - Proactively throttle when remaining < 20 (safety margin)
  - Flag key as rate-limited on 429 response
  - Auto-unflag when `rate_limit_reset_at` passes
- [ ] Create `pterodactyl-mcp/src/auth/tokenRefresh.ts`:
  - Periodic JWT refresh loop (every 8 minutes for 10-minute tokens)
  - Re-authenticate WebSocket connections with new JWT
  - Handle refresh failures (key revoked, server offline)
- [ ] Create `pterodactyl-mcp/src/client/httpClient.ts`:
  - Bearer token auth (auto-inject from keyScopeResolver)
  - Rate-limit tracking (update rateLimitTracker from response headers)
  - 429 handling (flag key, rotate to next, retry)
  - Pagination auto-resolution (follow page links)
  - Timeout enforcement (30s default, 120s for uploads)
  - Retry with exponential backoff for 5xx errors
- [ ] Create `pterodactyl-mcp/src/client/websocketClient.ts`:
  - Obtain JWT via `GET /api/client/servers/{id}/websocket`
  - Connect to Wings WebSocket URL
  - Send auth message with JWT
  - Handle events: `console output`, `status`, `stats`, `jwt error`, `daemon message`
  - Implement reconnection with exponential backoff
  - Buffer last 200 console lines per connection
- [ ] Create `pterodactyl-mcp/src/client/pagination.ts`:
  - Auto-paginate list endpoints
  - Return complete result arrays
  - Respect rate limits between page fetches (1 request per 250ms when approaching limit)
- [ ] Create `pterodactyl-mcp/src/utils/pathSanitizer.ts`:
  - Reject paths containing `..` components
  - Reject absolute paths not starting with `/`
  - Normalize path separators
- [ ] Create `pterodactyl-mcp/src/utils/errorMapper.ts`:
  - Map Pterodactyl HTTP error responses to MCP error codes (-32001 through -32010)
- [ ] Create `pterodactyl-mcp/src/utils/confirmationGate.ts`:
  - Intercept `tools/call` for gated tools
  - Return error `-32001` if `confirm` parameter is missing or false
  - Special double-confirmation for `restore_backup` with `truncate: true`

### Testing

- [ ] **Unit:** `credentialStore.test.ts` — Verify key loading, decryption, caching, and refresh
- [ ] **Unit:** `keyScopeResolver.test.ts` — Verify tool→key_type mapping, server_scope filtering
- [ ] **Unit:** `rateLimitTracker.test.ts` — Verify remaining-count tracking, proactive throttling, auto-unflag
- [ ] **Unit:** `httpClient.test.ts` — Mock Pterodactyl API; verify Bearer auth injection, 429 handling with key rotation, pagination, timeout, 5xx retry
- [ ] **Unit:** `websocketClient.test.ts` — Mock WebSocket server; verify JWT auth, event handling, reconnection, console buffering
- [ ] **Unit:** `pathSanitizer.test.ts` — Verify rejection of `..`, validation of paths
- [ ] **Unit:** `confirmationGate.test.ts` — Verify gate enforcement for kill, delete, restore; verify double-confirm for truncate restore
- [ ] **Unit:** `errorMapper.test.ts` — Verify mapping of 404→-32004, 429→-32003, 403→-32002, etc.
- [ ] **Integration — MCP Protocol:**
  - [ ] Start Pterodactyl MCP server via stdio
  - [ ] Send `initialize` JSON-RPC; verify capabilities response
  - [ ] Send `tools/list`; verify tool definitions are returned with correct schemas
  - [ ] Send `tools/call` for a safe tool (e.g., `list_servers`); verify response format
  - [ ] Send `tools/call` for a gated tool without `confirm`; verify `-32001` error
  - [ ] Send `tools/call` for a gated tool with `confirm: true`; verify execution
- [ ] **Integration — Live Pterodactyl (Staging):**
  - [ ] Configure with real `ptla_` key; verify `list_servers` returns server data
  - [ ] Configure with real `ptlc_` key; verify `get_server_resources` returns resource data
  - [ ] Verify rate-limit tracking updates after real API calls
  - [ ] Verify WebSocket connection establishes and receives `stats` events

---

## Phase 2: Pterodactyl MCP Server — Tool Implementations

**Duration Estimate:** 1.5 weeks  
**Dependencies:** Phase 1 complete

### Objectives

Implement all MCP tool, resource, and prompt definitions as specified in `04_api_contracts.md`.

### Checklist

- [ ] Create `pterodactyl-mcp/src/tools/serverManagement.ts` — `list_servers`, `get_server`, `get_server_resources`
- [ ] Create `pterodactyl-mcp/src/tools/powerControl.ts` — `start_server`, `stop_server`, `restart_server`, `kill_server`
- [ ] Create `pterodactyl-mcp/src/tools/consoleAccess.ts` — `send_command`, `get_console_output`, `get_player_count`
  - `get_player_count` is a composite tool: sends `list` via WebSocket, waits for response, parses player count
- [ ] Create `pterodactyl-mcp/src/tools/fileManagement.ts` — `list_files`, `read_file`, `write_file`, `upload_file`, `rename_files`, `delete_files`
  - `upload_file` must handle the two-step Pterodactyl upload flow internally
  - All file paths pass through `pathSanitizer.ts`
- [ ] Create `pterodactyl-mcp/src/tools/backupManagement.ts` — `list_backups`, `create_backup`, `get_backup_status`, `restore_backup`
  - `create_backup` must poll for completion (5s intervals, up to 10 min)
  - `restore_backup` requires double-confirmation for truncate mode
- [ ] Create `pterodactyl-mcp/src/tools/scheduleManagement.ts` — `list_schedules`, `create_schedule`, `execute_schedule`
- [ ] Create `pterodactyl-mcp/src/tools/buildManagement.ts` — `get_build_config`, `update_build_config`
- [ ] Create `pterodactyl-mcp/src/resources/serverStatus.ts` — `pterodactyl://servers/{id}/status`
- [ ] Create `pterodactyl-mcp/src/resources/consoleStream.ts` — `pterodactyl://servers/{id}/console`
- [ ] Create `pterodactyl-mcp/src/resources/resourceUsage.ts` — `pterodactyl://servers/{id}/resources`
- [ ] Create `pterodactyl-mcp/src/prompts/deploymentGuide.ts` — `pterodactyl_deployment_guide` prompt template
- [ ] Create `pterodactyl-mcp/src/prompts/diagnosticGuide.ts` — `pterodactyl_diagnostic_guide` prompt template

### Testing

- [ ] **Unit:** Each tool file — Test input validation, output formatting, error handling
- [ ] **Unit:** `get_player_count.test.ts` — Mock WebSocket; send `list` command; parse "There are 5 of a max of 20 players online"; verify output; test timeout case
- [ ] **Unit:** `upload_file.test.ts` — Mock two-step upload flow; verify signed URL retrieval and PUT execution
- [ ] **Unit:** `create_backup.test.ts` — Mock backup creation + polling; verify blocking until completion; verify timeout behavior
- [ ] **Integration — Live Pterodactyl (Staging):**
  - [ ] **Server management:** Call `list_servers`, `get_server`, `get_server_resources` against staging panel
  - [ ] **Power control:** Call `start_server`, verify server starts; call `stop_server`, verify server stops
  - [ ] **Console:** Call `send_command` with `say Hello MCP`; verify via `get_console_output`
  - [ ] **Player count:** Call `get_player_count` with players online; verify count
  - [ ] **File operations:** Call `list_files` for `/mods/`; `read_file` for `server.properties`; `write_file` for a test config; `upload_file` for a small test JAR; `delete_file` for the test file (with confirm)
  - [ ] **Backups:** Call `create_backup`; verify it blocks until completion; call `restore_backup` (without truncate, with confirm); verify restoration
  - [ ] **Resources:** Subscribe to `pterodactyl://servers/{id}/console`; verify console output events arrive; subscribe to resources; verify stats events arrive
  - [ ] **Rate limit:** Execute 50 rapid `list_files` calls; verify rate-limit tracking and throttling work correctly

---

## Phase 3: Vanguard — Discord Gateway & Event Routing

**Duration Estimate:** 1 week  
**Dependencies:** Phase 0 complete (can run in parallel with Phases 1-2)

### Checklist

(Same as original Phase 1 — no Pterodactyl changes needed in Vanguard)

- [ ] Complete Vanguard gateway, crash detector, paste link extractor, forum watcher
- [ ] Thread management, IPC transport, Discord UI components
- [ ] Unit and integration tests for message interception and IPC publishing

---

## Phase 4: Aegis Core, Sandbox & MCP Client

**Duration Estimate:** 1.5 weeks  
**Dependencies:** Phases 0, 1, and 2 complete

### Objectives

Build Aegis's autonomous orchestration loop, VM sandbox provisioner, inference pipeline, and the MCP client manager that connects to the Pterodactyl MCP server.

### Checklist

- [ ] Create `aegis/src/core/` — orchestrator, planner, executor, evaluator, reporter
- [ ] Create `aegis/src/sandbox/` — vmProvisioner, shellExec, fileBridge, resourceMonitor
- [ ] Create `aegis/src/mcp/mcpClientManager.ts` — Connect to MCP servers (pterodactyl, filesystem)
  - `initialize` — Handshake with each configured server
  - `discoverTools` — Call `tools/list` on each server; register in toolRegistry
  - `invokeTool` — Call `tools/call` on the appropriate server
  - `subscribeResource` — Subscribe to MCP resources
  - `handleResourceUpdate` — Forward resource updates to interested components
  - `getCircuitBreakerState` — Check if a server's circuit breaker is open
- [ ] Create `aegis/src/mcp/transport/stdioTransport.ts` — JSON-RPC over stdio
- [ ] Create `aegis/src/mcp/transport/sseTransport.ts` — JSON-RPC over SSE
- [ ] Create `aegis/src/mcp/toolRegistry.ts` — Unified tool registry (builtin + skill + MCP)
- [ ] Create `aegis/src/mcp/authDelegate.ts` — Delegates credential resolution to MCP servers
- [ ] Create `aegis/src/mcp/config/mcpServers.json` — Pterodactyl and filesystem MCP configs
- [ ] Create `aegis/src/inference/` — keyVault, loadBalancer, resilientClient, providers
- [ ] Create `aegis/src/skills/` — skillEngine, skillRunner, skillManifest

### Testing

- [ ] **Unit:** `mcpClientManager.test.ts` — Mock stdio transport; verify tool discovery, invocation, resource subscription
- [ ] **Unit:** `toolRegistry.test.ts` — Verify registration from all sources, namespace collision handling
- [ ] **Unit:** `loadBalancer.test.ts` — Round-robin with 3+ keys; 429 flagging and key skipping
- [ ] **Unit:** `shellExec.test.ts` — Timeout, buffer limits, secret redaction
- [ ] **Integration — MCP Client ↔ Pterodactyl MCP Server:**
  - [ ] Start Pterodactyl MCP server
  - [ ] Aegis MCP client connects via stdio
  - [ ] Call `tools/list` — verify Aegis discovers all Pterodactyl tools
  - [ ] Call `list_servers` through Aegis — verify results
  - [ ] Call `get_player_count` through Aegis — verify composite tool works
  - [ ] Subscribe to console resource — verify Aegis receives console events
  - [ ] Trigger a 429 by exhausting rate limits — verify Aegis MCP client handles the `-32003` error
- [ ] **Integration — VM Sandbox Lifecycle:**
  - [ ] Create/destroy sandbox containers; verify resource limits
  - [ ] Execute shell commands; verify output capture
  - [ ] File bridge operations; verify bidirectional transfer

---

## Phase 5: Crash Diagnostic Lifecycle

**Duration Estimate:** 1 week  
**Dependencies:** Phases 3 and 4 complete

### Checklist

- [ ] Implement crash diagnostic state machine using MCP Pterodactyl tools
  - Aegis uses `send_command` and `get_console_output` instead of direct WebSocket
  - Aegis uses `read_file` to inspect server config files
  - Aegis uses `get_server_resources` to check server health
- [ ] Web search integration for crash resolution
- [ ] Skill file: `crash-parser.py`
- [ ] Interactive thread monitoring and conversation

### Testing

- [ ] End-to-end crash diagnostic via MCP tools
- [ ] Error recovery when MCP tools fail (circuit breaker open, credentials exhausted)

---

## Phase 6: Suggestion Evaluation & Deduplication

**Duration Estimate:** 1.5 weeks  
**Dependencies:** Phases 3 and 4 complete

### Checklist

- [ ] Mod resolution via CurseForge/Modrinth
- [ ] Overlap state engine (using `list_files` MCP tool to check server mods)
- [ ] Bytecode profiling in sandbox
- [ ] Admin UI (checkboxes, modals, buttons)
- [ ] Approval → maintenance queue flow

### Testing

- [ ] End-to-end suggestion flow with partial overlap
- [ ] Bytecode profiling pipeline integration
- [ ] Admin approval/rejection modal flow

---

## Phase 7: Deployment Pipeline & Cron Scheduler

**Duration Estimate:** 1.5 weeks  
**Dependencies:** Phases 2, 4, and 6 complete

### Objectives

Implement the cron-based deployment lifecycle entirely through MCP tools. Aegis never calls Pterodactyl directly — it invokes MCP tools like `create_backup`, `upload_file`, `stop_server`, `start_server`, `get_player_count`, and `send_command`.

### Checklist

- [ ] Create `aegis/src/cron/playerMonitor.ts` — Uses `get_player_count` MCP tool
- [ ] Create `aegis/src/cron/deploymentRunner.ts` — Executes deployment via MCP tools:
  1. `create_backup` (with polling)
  2. `get_backup_status` (verify integrity)
  3. `upload_file` (stage files)
  4. `send_command` (in-game warning)
  5. `stop_server` (graceful, with timeout)
  6. `start_server` (power on)
  7. Subscribe to `pterodactyl://servers/{id}/console` (monitor boot)
  8. `send_command` with `tps` (TPS validation)
  9. `get_server_resources` (health check)
  10. Generate changelog (via inference)
- [ ] Implement rollback via MCP tools:
  - `stop_server`
  - `restore_backup` (with confirm)
  - `start_server`
  - Health validation
- [ ] Admin override commands (`@Vanguard force restart`, etc.)
- [ ] Skill files: `config-override.py`, `jar-validator.py`

### Testing

- [ ] **Unit:** `playerMonitor.test.ts` — Mock `get_player_count` MCP tool; verify zero-player detection
- [ ] **Unit:** `deploymentRunner.test.ts` — Mock all MCP tools; verify step sequence and error branching
- [ ] **Integration — Full Deployment Sequence (Staging Server):**
  - [ ] Create maintenance queue entry with a small, safe mod
  - [ ] **Backup:** Call `create_backup` via Aegis → MCP → Pterodactyl; verify backup created
  - [ ] **File upload:** Call `upload_file` via Aegis → MCP → Pterodactyl; verify file on server
  - [ ] **Server stop:** Call `stop_server`; verify graceful shutdown
  - [ ] **Server start:** Call `start_server`; verify boot
  - [ ] **Console monitoring:** Subscribe to console resource; verify "Done" message detected
  - [ ] **TPS validation:** Call `send_command` with `tps`; call `get_console_output`; parse TPS
  - [ ] **Health check:** Call `get_server_resources`; verify memory/CPU within bounds
  - [ ] **Changelog:** Verify embed posted to `#change-logs`
- [ ] **Integration — Rollback:**
  - [ ] Deploy a broken mod; verify health check failure
  - [ ] Verify automatic rollback via `restore_backup` (with confirm: true)
  - [ ] Verify server returns to pre-deployment state
- [ ] **Integration — Cron Zero-Player:**
  - [ ] With players online, verify no deployment
  - [ ] When players leave, verify deployment triggers within 60s
- [ ] **Integration — MCP Circuit Breaker:**
  - [ ] Simulate Pterodactyl MCP server failure (kill the container)
  - [ ] Verify Aegis detects circuit open and marks Pterodactyl tools as unavailable
  - [ ] Verify admin alert is published
  - [ ] Restart MCP server; verify circuit closes and tools become available

---

## Phase 8: Dynamic Skill Engine & Additional MCP Integration

**Duration Estimate:** 1 week  
**Dependencies:** Phase 4 complete

### Checklist

- [ ] Skill file discovery, validation, registration, execution
- [ ] Dynamic skill synthesis (Aegis writes its own scripts)
- [ ] Additional MCP server connections (filesystem, web-search)
- [ ] MCP health monitoring and auto-reconnect

### Testing

- [ ] Skill synthesis end-to-end
- [ ] MCP server connection lifecycle
- [ ] Tool availability updates on MCP server status change

---

## Phase 9: Polish, Observability & Hardening

**Duration Estimate:** 1 week  
**Dependencies:** All previous phases complete

### Checklist

- [ ] Structured logging with correlation IDs across all three services
- [ ] Graceful shutdown for Vanguard, Aegis, and Pterodactyl MCP
- [ ] Health check endpoints (`/health`) for all containers
- [ ] Operational runbook
- [ ] Security hardening (key isolation, path sanitization, confirmation gates)
- [ ] Load testing (concurrent operations, deployment mutual exclusion)
- [ ] Pterodactyl credential rotation procedure (add new key → verify → remove old key)

### Testing

- [ ] Graceful shutdown of each service mid-task
- [ ] Concurrent operations (5 crash threads, 3 suggestion threads)
- [ ] Security audit (no API keys in logs, sandbox boundary enforcement)
- [ ] Pterodactyl key rotation without Aegis restart
- [ ] MCP server restart without Aegis restart (reconnection)

---

## Phase 10: Release Engineering & Patch Generation

**Duration Estimate:** 3-4 days  
**Dependencies:** Phase 9 complete

### Objectives

Perform the final validation pass, generate the release artifact, and produce the patch series. This phase ensures that the codebase is in a fully deployable state with a complete audit trail.

### Checklist

- [ ] **Verify Clean Git Status**
  - [ ] `git status` shows no uncommitted changes on `develop`
  - [ ] `git log --oneline --graph` shows clean, linear history on `develop`
  - [ ] All feature branches from Phases 0-9 have been merged and deleted
  - [ ] No stale or orphaned branches exist (`git branch -a` review)
- [ ] **Run Full Test Suite**
  - [ ] `npm run test:all` — All unit tests pass
  - [ ] `npm run test:integration` — All integration tests pass
  - [ ] `npm run test:e2e` — All end-to-end tests pass (including live Pterodactyl staging)
  - [ ] `npm run lint` — Zero lint errors
  - [ ] `npm run typecheck` — Zero type errors
  - [ ] `npm audit` — No critical or high-severity vulnerabilities
- [ ] **Architecture Consistency Audit**
  - [ ] Complete the audit checklist in `10_architecture_consistency_audit.md`
  - [ ] Verify: Aegis never directly calls Pterodactyl (zero violations in codebase)
  - [ ] Verify: All Pterodactyl operations route through MCP tools
  - [ ] Verify: `ptero_credentials` table exists and `ptero_mcp_app` role is configured
  - [ ] Verify: Key rotation is documented and tested
  - [ ] Verify: Git workflow is documented and enforced
  - [ ] Verify: Patch export workflow is documented and tested
  - [ ] Verify: Testing strategy covers all critical paths
  - [ ] Verify: Deployment rollback is documented and tested
- [ ] **Generate Release Tag**
  - [ ] Bump version in all `package.json` files
  - [ ] Create release branch: `git checkout -b release/v1.0.0 develop`
  - [ ] Merge release branch to `main` with `--no-ff`
  - [ ] Create annotated tag: `git tag -a v1.0.0 -m "EdenVanguard v1.0.0 — Initial production release"`
  - [ ] Verify tag: `git show v1.0.0`
- [ ] **Generate Patch Series**
  - [ ] Create output directory: `mkdir -p patches/v1.0.0`
  - [ ] Generate patches: `git format-patch --root HEAD -o patches/v1.0.0/`
  - [ ] Verify patch count and last patch filename
  - [ ] Verify patch integrity by replaying on a fresh repository:
    ```bash
    mkdir /tmp/edenvanguard-verify && cd /tmp/edenvanguard-verify
    git init
    git am /path/to/patches/v1.0.0/*.patch
    npm install && npm run build && npm run test:all
    ```
  - [ ] Record patch count and SHA-256 checksums of each patch file
- [ ] **Create Release Artifact Bundle**
  - [ ] Create `release/v1.0.0/` directory
  - [ ] Copy `patches/v1.0.0/` to `release/v1.0.0/patches/`
  - [ ] Copy `docs/` to `release/v1.0.0/docs/`
  - [ ] Generate commit log: `git log --oneline --graph > release/v1.0.0/commit-log.txt`
  - [ ] Generate commit hashes: `git log --format="%H %s" > release/v1.0.0/commit-hashes.txt`
  - [ ] Write version file: `echo "v1.0.0" > release/v1.0.0/version.txt`
  - [ ] Create compressed archive: `tar czf edenvanguard-v1.0.0.tar.gz release/v1.0.0/`
  - [ ] Compute SHA-256 of the archive: `sha256sum edenvanguard-v1.0.0.tar.gz`
  - [ ] Store the archive and checksum in a secure, backed-up location
- [ ] **Back-merge to Develop**
  - [ ] `git checkout develop && git merge main`
  - [ ] Delete release branch: `git branch -d release/v1.0.0`
  - [ ] Push `main` and `develop` to remote
  - [ ] Push tag: `git push origin v1.0.0`

### Testing

- [ ] Patch replay verification (full test suite passes on replayed repo)
- [ ] Release artifact extraction and verification
- [ ] Deployment from release artifact on clean machine
- [ ] Rollback from release artifact to previous known-good state

---

## Phase Timeline Summary (Revised)

| Phase | Duration | Key Deliverable | Critical Testing Focus |
|---|---|---|---|
| **0** | 4-5 days | Git bootstrap, infrastructure & scaffolding | IPC connectivity, DB access, credential isolation, Git workflow |
| **1** | 1.5 weeks | Pterodactyl MCP core & auth | **Key management, rate limiting, WebSocket lifecycle** |
| **2** | 1.5 weeks | Pterodactyl MCP tool implementations | **All tools against live staging panel** |
| **3** | 1 week | Vanguard Discord gateway | Crash detection, message routing |
| **4** | 1.5 weeks | Aegis core, sandbox, MCP client | **MCP client ↔ Ptero MCP server integration** |
| **5** | 1 week | Crash diagnostic lifecycle | End-to-end via MCP tools |
| **6** | 1.5 weeks | Suggestion & deduplication | Bytecode profiling, admin UI |
| **7** | 1.5 weeks | Deployment pipeline & cron | **Full Pterodactyl deployment via MCP** |
| **8** | 1 week | Dynamic skills & MCP integration | Skill synthesis, MCP reconnection |
| **9** | 1 week | Polish & hardening | Circuit breakers, key rotation, concurrency |
| **10** | 3-4 days | Release engineering & patch generation | **Patch replay, artifact verification, audit** |

**Total estimated duration: 10-12 weeks** for a single developer, or 6-7 weeks with a two-person team (Phases 1+2 and 3+4 can proceed in parallel).

---

## Risk Register (Revised)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Pterodactyl MCP server crash during deployment | Medium | Critical (deployment stalls) | Aegis circuit breaker detects MCP failure; admin alert; manual fallback via Vanguard admin commands |
| Rate limit exhaustion across all keys | Medium | High (operations blocked) | Multiple keys per type; proactive throttling at 20 remaining; configurable key pool size |
| WebSocket JWT expiry during long operation | Low | Medium (console stream lost) | 8-minute refresh loop; auto-reconnect on 4004 close code |
| Player count derivation fails (no response to `list` command) | Medium | Medium (deployment never triggers) | Timeout with -1 result; fallback: check `get_server_resources` for running state + previous player count trend |
| Backup creation exceeds 10-minute timeout | Low | High (deployment aborts) | Increase timeout for large servers; implement partial backup with ignored paths; alert admin for manual backup |
| MCP server stdio transport deadlock | Low | Critical (all Ptero ops blocked) | Heartbeat messages between Aegis and MCP server; detect deadlock; restart MCP server process |
| Concurrent deployment race condition | Low | Critical (data corruption) | PostgreSQL advisory locks; only one deployment per server at a time; Aegis planner checks queue before starting |
| Pterodactyl panel version incompatibility | Low | Medium (endpoint changes) | Version check at MCP server startup; pin to tested Pterodactyl version; graceful degradation for unknown endpoints |
