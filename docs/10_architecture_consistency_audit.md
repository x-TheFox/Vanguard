# 10 — Architecture Consistency Audit

This document provides a comprehensive audit of the EdenVanguard system architecture. It lists every subsystem, its responsibilities, its dependencies, and verifies that no architectural contradictions remain across the ten blueprint documents. It concludes with an Implementation Readiness Assessment that determines whether the system is ready for coding to begin.

---

## 1. Subsystem Inventory

### 1.1 Vanguard (Discord Interface Layer)

| Property | Detail |
|---|---|
| **Codebase** | `vanguard/` |
| **Database role** | `vanguard_app` (mostly read-only, write on `suggestion_threads` and `audit_log`) |
| **Pterodactyl access** | None — Vanguard never touches Pterodactyl |
| **External connections** | Discord Gateway (WSS), NATS JetStream, PostgreSQL |

**Responsibilities:**

- Own all Discord.js gateway listeners, slash-command registrations, modal dispatchers, button handlers, and message-intercept pipelines
- Detect crash report signatures in messages (via `crashDetector.ts`)
- Extract paste link content from mclogs, pastebin, gnome.dev URLs (via `pasteLinkExtractor.ts`)
- Watch the Suggestions Forum for new threads (via `forumWatcher.ts`)
- Create, archive, and lock Discord threads for diagnostics and evaluations (via `threadManager.ts`)
- Build Discord UI components: checkboxes for mod selection, action buttons for approval/rejection, modals for admin notes (via `checkboxBuilder.ts`, `modalDispatcher.ts`, `buttonHandler.ts`)
- Publish task payloads to NATS JetStream (`vanguard.crash.new`, `vanguard.suggestion.new`)
- Subscribe to Aegis result streams on NATS and post updates to Discord threads
- Enforce admin-only guards on approval/rejection buttons
- Route admin override commands (`@Vanguard force restart`, etc.) to Aegis via NATS

**Dependencies:**

- Discord API (Gateway WebSocket)
- NATS JetStream (IPC bus to Aegis)
- PostgreSQL (read operational state, write audit entries and suggestion thread updates)
- `shared/` types (IPC message envelopes, task payloads)

**Verified: No Pterodactyl dependency.** Vanguard never imports, references, or communicates with any Pterodactyl endpoint or MCP tool.

---

### 1.2 Aegis (Autonomous Intelligence Core)

| Property | Detail |
|---|---|
| **Codebase** | `aegis/` |
| **Database role** | `aegis_app` (read/write on operational tables, NO access to `ptero_credentials`) |
| **Pterodactyl access** | **MCP protocol only** — via `aegis/src/mcp/mcpClientManager.ts` |
| **External connections** | NATS JetStream, PostgreSQL, Docker API (sandbox), MCP servers (stdio/SSE), LLM providers (HTTPS) |

**Responsibilities:**

- Receive task payloads from Vanguard via NATS JetStream
- Decompose tasks into execution plans using the planner (`aegis/src/core/planner.ts`)
- Execute plans step-by-step using the executor (`aegis/src/core/executor.ts`)
- All external tool invocations route exclusively through the MCP client manager (`aegis/src/mcp/mcpClientManager.ts`)
- Discover MCP tools at runtime via `tools/list` protocol
- Invoke MCP tools via `tools/call` protocol (e.g., `Aegis.mcp.invoke("create_backup", {...})`)
- Subscribe to MCP resources (e.g., `pterodactyl://servers/{id}/console`) for real-time data
- Manage VM sandbox lifecycle (create/destroy containers, execute shell commands, file bridge)
- Run skill scripts inside sandbox with resource limits
- Synthesize new skill scripts dynamically when gaps are detected
- Manage LLM inference pipeline (key vault, load balancer, 429-resilient client)
- Execute cron-based player monitoring and deployment sequences
- Stream progress updates back to Vanguard via NATS

**Dependencies:**

- NATS JetStream (IPC bus from Vanguard)
- PostgreSQL (operational state — `api_keys`, `suggestion_threads`, `maintenance_queue`, `skill_registry`, `cron_jobs`, `deployment_audit`)
- Docker API (sandbox container management)
- Pterodactyl MCP Server (via stdio JSON-RPC — MCP protocol)
- Filesystem MCP Server (via stdio JSON-RPC — MCP protocol)
- LLM providers: Groq, OpenCode Zen (via HTTPS)
- Web search (via MCP or direct HTTP)
- `shared/` types and crypto

**Verified: No direct Pterodactyl dependency.** Aegis accesses Pterodactyl exclusively through MCP tool invocations. It never makes HTTP requests to the Pterodactyl panel, never holds Pterodactyl API keys, and never opens WebSocket connections to Wings. The `aegis_app` database role has no access to `ptero_credentials`.

---

### 1.3 Pterodactyl MCP Server (First-Class MCP Tool Layer)

| Property | Detail |
|---|---|
| **Codebase** | `pterodactyl-mcp/` |
| **Database role** | `ptero_mcp_app` (read/write on `ptero_credentials`, NO access to `api_keys`, NO DELETE) |
| **Pterodactyl access** | **Full access** — HTTPS REST + WSS WebSocket to Pterodactyl Panel |
| **External connections** | Aegis (via stdio JSON-RPC — MCP protocol), PostgreSQL, Pterodactyl Panel (HTTPS + WSS) |

**Responsibilities:**

- Expose Pterodactyl operations as schema-defined, discoverable MCP tools
- Implement MCP protocol handlers: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/subscribe`, `prompts/list`, `prompts/get`
- Load, decrypt, cache, and rotate `ptla_` and `ptlc_` keys from `ptero_credentials`
- Resolve key type per tool invocation (Application vs. Client) via `keyScopeResolver.ts`
- Track rate limits per key from `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers
- Proactively throttle when remaining requests drop below 20
- Rotate to next available key on 429 response
- Manage WebSocket connection pool (connect, authenticate, refresh JWT, reconnect)
- Auto-paginate list endpoints and return complete result sets
- Poll for asynchronous operation completion (backup creation)
- Implement composite tools (e.g., `get_player_count` that sends `list` command and parses console output)
- Enforce confirmation gates on dangerous operations (kill, delete, restore with truncate)
- Block excluded operations entirely (user CRUD, server delete, allocation management)
- Sanitize file paths to prevent directory traversal
- Map Pterodactyl HTTP errors to MCP error codes

**Dependencies:**

- Aegis (as MCP client — stdio JSON-RPC)
- PostgreSQL (`ptero_credentials` table — encrypted key storage, rate limit tracking)
- Pterodactyl Panel (Application API + Client API via HTTPS, WebSocket via WSS)
- `shared/` crypto (AES-256-GCM for token decryption)

**Verified: Full Pterodactyl access is centralized here.** This is the only subsystem that makes direct HTTP/WS requests to the Pterodactyl panel. All other subsystems access Pterodactyl capabilities exclusively through this MCP server's tool interface.

---

### 1.4 PostgreSQL Database

| Property | Detail |
|---|---|
| **Codebase** | `02_database_schema.sql` |
| **Roles** | `aegis_app`, `vanguard_app`, `ptero_mcp_app` |

**Responsibilities:**

- Store encrypted LLM provider API keys (`api_keys` table — AES-256-GCM)
- Store encrypted Pterodactyl credentials (`ptero_credentials` table — AES-256-GCM with `token_hash` for dedup)
- Track suggestion thread lifecycle and mod identifiers (`suggestion_threads` table)
- Manage deployment queue and execution state (`maintenance_queue` table)
- Record deployment audit trail (`deployment_audit` table — append-only)
- Track rate limit events for analytics (`rate_limit_events` table)
- Register dynamic skill scripts (`skill_registry` table)
- Schedule cron jobs (`cron_jobs` table)
- Audit all mutable table changes (`audit_log` table — generic trigger-based)
- Provide atomic round-robin key selection via `get_next_valid_key()` with `FOR UPDATE SKIP LOCKED`
- Provide atomic rate-limit flagging via `flag_rate_limited_key()`
- Reset daily token quotas via `reset_daily_quotas()`
- Auto-update `updated_at` columns via triggers

**Dependencies:**

- None (foundational data layer)

**Verified: Credential isolation is enforced at the database role level.** `aegis_app` cannot read `ptero_credentials`; `ptero_mcp_app` cannot read `api_keys`; no role has DELETE on `ptero_credentials`.

---

### 1.5 NATS JetStream (IPC Message Bus)

| Property | Detail |
|---|---|
| **Codebase** | Infrastructure (Docker service) |
| **Consumers** | Vanguard (publisher), Aegis (subscriber and publisher) |

**Responsibilities:**

- Transport structured task payloads from Vanguard to Aegis
- Transport result streams from Aegis to Vanguard
- Provide durable message delivery with replay capability
- Subject taxonomy: `vanguard.crash.new`, `vanguard.crash.followup`, `vanguard.suggestion.new`, `aegis.result.crash`, `aegis.result.suggestion`, `aegis.result.deployment`

**Dependencies:**

- None (foundational messaging layer)

**Verified: No Pterodactyl dependency.** NATS never communicates with Pterodactyl.

---

### 1.6 VM Sandbox (Docker/Firecracker)

| Property | Detail |
|---|---|
| **Codebase** | `aegis/src/sandbox/` |
| **Database role** | None (uses Docker API directly) |

**Responsibilities:**

- Provide ephemeral, isolated execution environments for shell commands and skill scripts
- Enforce resource limits: 2 CPU cores, 4 GB RAM, 20 GB disk, 30-minute execution timeout
- Execute shell commands with timeout enforcement, buffer limits, and secret redaction
- Provide bidirectional file transfer (host ↔ sandbox) via `fileBridge.ts`
- Monitor sandbox resource usage via `resourceMonitor.ts`
- Clean up containers after task completion

**Dependencies:**

- Docker API (host-level)
- Aegis orchestrator (task dispatch)

**Verified: No Pterodactyl dependency.** The sandbox is a general-purpose execution environment; it does not contain Pterodactyl client code.

---

### 1.7 Skill File Engine

| Property | Detail |
|---|---|
| **Codebase** | `aegis/src/skills/` |
| **Database role** | `aegis_app` (via Aegis) |

**Responsibilities:**

- Discover skill files in `aegis/skills/` directory with YAML frontmatter
- Validate skill file structure (language, parameters, description)
- Register skills as MCP-compatible tools in the tool registry
- Execute skill scripts inside the sandbox with resource limits
- Support dynamic skill synthesis: Aegis can write new scripts when it encounters tool gaps
- Hot-reload skills when files change
- Track invocation counts and last-invoked timestamps in `skill_registry` table

**Dependencies:**

- Aegis sandbox (for execution)
- Aegis tool registry (for registration)
- Aegis inference pipeline (for synthesis)
- PostgreSQL (`skill_registry` table)

**Verified: No Pterodactyl dependency.** Skills can invoke Pterodactyl MCP tools through the same `Aegis.mcp.invoke()` interface as any other tool, but the skill engine itself has no direct Pterodactyl code.

---

### 1.8 Inference Pipeline

| Property | Detail |
|---|---|
| **Codebase** | `aegis/src/inference/` |
| **Database role** | `aegis_app` (via Aegis) |

**Responsibilities:**

- Manage LLM provider API keys via `keyVault.ts` (encrypted in `api_keys` table)
- Implement round-robin key selection via `loadBalancer.ts` using `get_next_valid_key()`
- Provide 429-resilient inference client via `resilientClient.ts`
- Auto-flag rate-limited keys, rotate to next, transparently retry
- Support multiple providers (Groq, OpenCode Zen) with provider-specific adapters

**Dependencies:**

- PostgreSQL (`api_keys` table — NOT `ptero_credentials`)
- LLM provider APIs (HTTPS)

**Verified: No Pterodactyl dependency.** The inference pipeline handles LLM provider keys only; Pterodactyl keys are managed by the MCP server exclusively.

---

### 1.9 Deployment Pipeline & Cron Scheduler

| Property | Detail |
|---|---|
| **Codebase** | `aegis/src/cron/` |
| **Database role** | `aegis_app` (via Aegis) |

**Responsibilities:**

- Monitor player count via `Aegis.mcp.invoke("get_player_count", {server_id})`
- Execute deployment lifecycle (backup → file swap → restart → health check → TPS validation → changelog)
- All Pterodactyl operations use MCP tools exclusively (create_backup, stop_server, start_server, etc.)
- Implement rollback via MCP tools (stop_server, restore_backup with confirm, start_server)
- Manage cron job scheduling and registration
- Admin override commands dispatched via Vanguard

**Dependencies:**

- Aegis MCP client (for all Pterodactyl operations)
- Aegis sandbox (for staging file validation)
- Aegis inference (for changelog generation)
- PostgreSQL (`maintenance_queue`, `deployment_audit`, `cron_jobs` tables)

**Verified: No direct Pterodactyl dependency.** Every Pterodactyl operation in the deployment pipeline routes through `Aegis.mcp.invoke()`. The state machine in `03_state_machines.md` has been audited and corrected — all `Aegis.pterodactyl.*` patterns have been replaced with `Aegis.mcp.invoke("tool_name", {...})` patterns.

---

## 2. Contradiction Verification

### 2.1 Aegis Never Directly Calls Pterodactyl

**Status: VERIFIED — No contradictions found**

| Document | Check | Result |
|---|---|---|
| `01_system_architecture.md` | Section 1 (High-Level Overview) states "Aegis discovers and invokes tools exclusively through the MCP protocol" | PASS |
| `01_system_architecture.md` | Section 4.1 (Design Decisions) documents the shift from direct REST to MCP server | PASS |
| `01_system_architecture.md` | Section 5 (Component Responsibility Matrix) shows Aegis Pterodactyl access as "Via MCP protocol to pterodactyl-mcp" | PASS |
| `01_system_architecture.md` | Section 10 (Security Boundaries) shows Aegis ↔ Pterodactyl as "MCP protocol only" | PASS |
| `03_state_machines.md` | Section A (Crash Diagnostics) — all Pterodactyl operations use `Aegis.mcp.invoke()` | PASS |
| `03_state_machines.md` | Section B (Suggestion Dedup) — `list_files` invoked via `Aegis.mcp.invoke("list_files", ...)` | PASS |
| `03_state_machines.md` | Section C (Deployment) — all 14 Pterodactyl operations use `Aegis.mcp.invoke()` | PASS |
| `04_api_contracts.md` | All Pterodactyl operations defined as MCP tools, not REST endpoints | PASS |
| `05_feature_expansion.md` | Feature 1 integration point references "MCP Pterodactyl tools (invoked via Aegis.mcp.invoke())" | PASS |
| `05_feature_expansion.md` | Feature 3 integration point references "MCP Pterodactyl tool invocations" | PASS |
| `06_implementation_phases.md` | Phase 4 (Aegis core) checklist includes MCP client, not Pterodactyl REST client | PASS |
| `06_implementation_phases.md` | Phase 7 (Deployment) explicitly states "all Pterodactyl operations use MCP tools" | PASS |
| `07_pterodactyl_research.md` | All endpoints mapped as MCP tool candidates, not direct Aegis calls | PASS |
| `08_risks_and_limits.md` | Permission gate taxonomy references MCP tool names, not REST endpoints | PASS |
| `09_development_workflow.md` | Commit examples use MCP tool invocations, not direct Pterodactyl calls | PASS |

**Search verification:** Grep for `Aegis.pterodactyl`, `pterodactyl.fileManager`, `pterodactyl.backupManager`, `pterodactyl.serverPower`, `pterodactyl.consoleStream`, `pterodactyl.serverResources`, `aegis/src/pterodactyl/` across all documents yields zero results.

---

### 2.2 Pterodactyl Only Exposed Through MCP

**Status: VERIFIED — No contradictions found**

| Document | Check | Result |
|---|---|---|
| `01_system_architecture.md` | Pterodactyl MCP Server is a standalone process; Aegis connects via MCP protocol | PASS |
| `01_system_architecture.md` | No `aegis/src/pterodactyl/` directory exists in the file structure | PASS |
| `04_api_contracts.md` | All Pterodactyl operations are MCP tool definitions with JSON Schema | PASS |
| `08_risks_and_limits.md` | Excluded endpoints are not exposed as MCP tools — Aegis has no way to access them | PASS |

---

### 2.3 Credential Storage Exists

**Status: VERIFIED — No contradictions found**

| Document | Check | Result |
|---|---|---|
| `02_database_schema.sql` | `ptero_credentials` table with `credential_type` ENUM, `encrypted_token`, `token_nonce`, `token_tag`, `token_hash`, `server_scope` JSONB, `permissions` JSONB, `is_active`, `rate_limit_remaining`, `rate_limit_reset_at` | PASS |
| `02_database_schema.sql` | `ptero_mcp_app` role with SELECT/INSERT/UPDATE (no DELETE) on `ptero_credentials` | PASS |
| `02_database_schema.sql` | GIN indexes on `server_scope` and `permissions` for efficient lookup | PASS |
| `02_database_schema.sql` | UNIQUE constraint on `token_hash` for duplicate prevention | PASS |
| `01_system_architecture.md` | Section 7.1 documents the `ptero_credentials` schema and design decisions | PASS |
| `01_system_architecture.md` | Section 7.2 documents the key selection algorithm | PASS |
| `08_risks_and_limits.md` | Section 9.1 provides SQL example for adding a new key | PASS |

---

### 2.4 Key Rotation Is Documented

**Status: VERIFIED — No contradictions found**

| Document | Check | Result |
|---|---|---|
| `02_database_schema.sql` | Migration notes document key rotation: INSERT new → reload MCP → verify → UPDATE old to is_active=false → never DELETE | PASS |
| `01_system_architecture.md` | Section 7.2 provides the full key selection algorithm | PASS |
| `08_risks_and_limits.md` | Section 2.2 documents the 6-step key rotation procedure | PASS |
| `08_risks_and_limits.md` | Section 9.1 provides SQL example for adding a new key | PASS |
| `06_implementation_phases.md` | Phase 9 checklist includes "Pterodactyl credential rotation procedure" | PASS |

---

### 2.5 Git Workflow Exists

**Status: VERIFIED — No contradictions found**

| Document | Check | Result |
|---|---|---|
| `09_development_workflow.md` | Section A.1: Repository initialization with `git init` and remote setup | PASS |
| `09_development_workflow.md` | Section A.2: Branch strategy (main, develop, feature/*) with protection rules | PASS |
| `09_development_workflow.md` | Section A.3: `.gitignore` requirements with secret protection | PASS |
| `09_development_workflow.md` | Section A.4: Code style enforcement (ESLint, Prettier, lint-staged, secret hooks) | PASS |
| `09_development_workflow.md` | Section B: Commit discipline (complete logical units, no WIP, architectural reasoning) | PASS |
| `09_development_workflow.md` | Section B.2: Conventional Commits format with project-specific types and scopes | PASS |
| `06_implementation_phases.md` | Phase 0 includes Git bootstrap checklist items | PASS |

---

### 2.6 Patch Export Workflow Exists

**Status: VERIFIED — No contradictions found**

| Document | Check | Result |
|---|---|---|
| `09_development_workflow.md` | Section C.1: Rationale for patch export (offline deployment, audit, reproducibility, rollback granularity, version documentation) | PASS |
| `09_development_workflow.md` | Section C.2: Patch generation commands (`git format-patch`) | PASS |
| `09_development_workflow.md` | Section C.3: Patch replay instructions (`git am`) | PASS |
| `09_development_workflow.md` | Section C.4: Rollback procedures (single commit, release tag, specific patch) | PASS |
| `09_development_workflow.md` | Section C.5: Release workflow (pre-release validation, release branch, tag, patch generation, artifact bundle, back-merge) | PASS |
| `06_implementation_phases.md` | Phase 0 includes patch export workflow setup | PASS |
| `06_implementation_phases.md` | Phase 10 includes patch generation, replay verification, and artifact creation | PASS |

---

### 2.7 Testing Strategy Exists

**Status: VERIFIED — No contradictions found**

| Document | Check | Result |
|---|---|---|
| `06_implementation_phases.md` | Every phase (0-10) includes dedicated testing sections with unit, integration, and e2e tests | PASS |
| `06_implementation_phases.md` | Phase 1: MCP protocol tests (initialize, tools/list, tools/call), live Pterodactyl staging tests | PASS |
| `06_implementation_phases.md` | Phase 2: All tool implementations tested individually + live staging integration | PASS |
| `06_implementation_phases.md` | Phase 4: MCP client ↔ Pterodactyl MCP server integration, VM sandbox lifecycle | PASS |
| `06_implementation_phases.md` | Phase 7: Full deployment sequence against staging server, rollback, cron, circuit breaker | PASS |
| `06_implementation_phases.md` | Phase 10: Patch replay verification, release artifact extraction | PASS |
| `08_risks_and_limits.md` | Section 6: MCP protocol safety constraints (schema validation, timeout, circuit breaker) | PASS |

---

### 2.8 Deployment Rollback Exists

**Status: VERIFIED — No contradictions found**

| Document | Check | Result |
|---|---|---|
| `03_state_machines.md` | Section C: FAILED → ROLLBACK transition with full MCP-based rollback sequence | PASS |
| `03_state_machines.md` | Rollback uses `Aegis.mcp.invoke("stop_server", ...)`, `Aegis.mcp.invoke("restore_backup", {confirm: true})`, `Aegis.mcp.invoke("start_server", ...)` | PASS |
| `06_implementation_phases.md` | Phase 7: Integration test for rollback (deploy broken mod → verify failure → verify automatic rollback) | PASS |
| `08_risks_and_limits.md` | Section 9.2: Emergency manual rollback via Pterodactyl panel (when MCP server is unavailable) | PASS |
| `08_risks_and_limits.md` | Section 9.3: Force-starting a stuck deployment | PASS |
| `09_development_workflow.md` | Section D.3: Deployment rollback process (automatic, manual via Aegis, manual via panel, code-level) | PASS |
| `09_development_workflow.md` | Section D.4: Pterodactyl rollback process with post-rollback verification checklist | PASS |

---

## 3. Cross-Document Consistency Matrix

| Property | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| Aegis uses MCP only | YES | — | YES | YES | YES | YES | — | YES | YES | YES |
| Ptero as MCP server | YES | — | — | YES | — | YES | YES | YES | — | YES |
| ptero_credentials table | YES | YES | — | — | — | YES | — | YES | — | YES |
| Credential isolation | YES | YES | — | — | — | YES | — | YES | — | YES |
| Key rotation documented | YES | YES | — | — | — | YES | — | YES | — | YES |
| Git workflow | — | — | — | — | — | YES | — | — | YES | YES |
| Patch export | — | — | — | — | — | YES | — | — | YES | YES |
| Testing per phase | — | — | — | — | — | YES | — | YES | — | YES |
| Rollback documented | — | — | YES | — | — | YES | — | YES | YES | YES |
| No direct Ptero access | YES | — | YES | YES | YES | YES | — | YES | YES | YES |

---

## 4. Implementation Readiness Assessment

### 4.1 Remaining Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Player count derivation is fragile** | Medium | The `get_player_count` composite tool sends `list` via WebSocket and parses console output. This depends on the Minecraft server's output format, which may change with version updates. Mitigation: Add multiple parsing strategies (regex patterns for different server implementations) and a timeout fallback that reports -1 rather than blocking. |
| **Pterodactyl rate limits may be tighter in production** | Medium | The research doc (07) documents 240 req/min/key, but production panels may be configured with lower limits. Mitigation: Make the proactive throttling threshold configurable (currently 20 remaining); support multiple keys per type from day one. |
| **WebSocket JWT refresh failure during deployment** | High | If a JWT cannot be refreshed during a deployment sequence (e.g., all Client keys are rate-limited), the console stream is lost and Aegis cannot monitor boot progress. Mitigation: Always maintain at least 2 Client keys per server scope; implement fallback to REST-based `get_console_output` tool when WebSocket is unavailable. |
| **MCP stdio transport deadlock** | High | If the Pterodactyl MCP server process hangs, the stdio pipe between Aegis and the MCP server could deadlock. Mitigation: Implement heartbeat messages; detect stale connections; restart the MCP server process on timeout. |
| **Concurrent deployment race condition** | High | Two admins could approve deployments simultaneously. Mitigation: PostgreSQL advisory locks ensure only one deployment per server at a time; `maintenance_queue` has unique constraints. |
| **Application API key compromise** | Critical | A compromised `ptla_` key grants full panel access. Mitigation: Minimize Application key use; audit all invocations; rotate immediately on suspicion. The MCP server logs every Application key usage with correlation IDs. |
| **No native backup completion webhook** | Low | Must poll for backup status, consuming API quota. Mitigation: 5-second poll interval with 10-minute timeout; this is well within the 240 req/min budget. |
| **Pterodactyl API version compatibility** | Low | Future Pterodactyl versions may change API endpoints. Mitigation: Version check at MCP server startup; pin to tested version; graceful degradation for unknown responses. |

### 4.2 Recommended Pre-Coding Tasks

Before writing the first line of application code (Phase 1), the following tasks should be completed:

1. **Set up the Pterodactyl staging panel**: A real Pterodactyl panel instance is required for Phase 1 and Phase 2 integration testing. This should be a dedicated test panel, not a production instance. Create at least one Application API key and one Client API key for testing.

2. **Create the Minecraft test server**: On the staging panel, create a Minecraft server with a known modpack configuration. This server will be the target for all integration tests (deployment, backup, file management, console access).

3. **Verify network connectivity**: Confirm that the development machine can reach the Pterodactyl panel (HTTPS) and the Wings daemon (WSS) from within the Docker network. Firewall rules may need adjustment.

4. **Encrypt and store test credentials**: Using the AES-256-GCM encryption utility from `shared/crypto/encrypt.ts` (built in Phase 0), encrypt the test `ptla_` and `ptlc_` keys and insert them into the `ptero_credentials` table. Verify that the `ptero_mcp_app` role can decrypt them.

5. **Establish CI/CD pipeline**: Configure the CI pipeline (GitHub Actions or equivalent) to run on every push to `develop`: lint, typecheck, unit tests, integration tests. This must be operational before Phase 1 begins.

6. **Review and lock the blueprint**: All ten documents should be reviewed by the implementation team and any final clarifications resolved. Once coding begins, changes to the architecture documents should follow the same commit discipline as code changes.

### 4.3 Go / No-Go Decision

**RECOMMENDATION: GO — with conditions**

The architecture is consistent across all ten documents. The following verification checks all pass:

- **Aegis never directly calls Pterodactyl**: Verified across all documents. Zero instances of `Aegis.pterodactyl.*` or `aegis/src/pterodactyl/` remain.
- **Pterodactyl only exposed through MCP**: Verified. The Pterodactyl MCP Server is the sole interface.
- **Credential storage exists**: Verified. `ptero_credentials` table is defined in `02_database_schema.sql` with full DDL, indexes, constraints, and documentation.
- **Key rotation is documented**: Verified in `02_database_schema.sql`, `01_system_architecture.md`, and `08_risks_and_limits.md`.
- **Git workflow exists**: Verified in `09_development_workflow.md` and `06_implementation_phases.md` Phase 0.
- **Patch export workflow exists**: Verified in `09_development_workflow.md` and `06_implementation_phases.md` Phase 10.
- **Testing strategy exists**: Verified in `06_implementation_phases.md` — every phase has dedicated testing sections.
- **Deployment rollback exists**: Verified in `03_state_machines.md`, `06_implementation_phases.md`, `08_risks_and_limits.md`, and `09_development_workflow.md`.

**Conditions for GO:**

1. The pre-coding tasks in Section 4.2 must be completed before Phase 1 begins.
2. The staging Pterodactyl panel must be operational and reachable from the Docker network.
3. At least one `ptla_` key and one `ptlc_` key must be provisioned in `ptero_credentials` before Phase 1 integration testing.
4. The CI/CD pipeline must be operational on the `develop` branch.

The architecture has no unresolved contradictions. The MCP purity constraint is enforced consistently across all documents. The credential isolation model is well-defined with database-level role enforcement. The development workflow and patch export process provide a complete audit trail from first commit to release artifact. The system is ready for implementation.
