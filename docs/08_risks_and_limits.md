# 08 — Risks, Limits & Safety Constraints

This document catalogues the safety boundaries, permission gates, operational constraints, and explicit exclusions that govern the EdenVanguard system. It serves as the definitive reference for what the autonomous agent can and cannot do, and what requires human oversight.

---

## 1. Permission Gate Taxonomy

Every operation in the system falls into one of three permission tiers:

### 1.1 Safe (Autonomous Execution Allowed)

Operations that are read-only, reversible, or low-impact. Aegis may execute these without admin confirmation.

| Operation | MCP Tool | Rationale |
|---|---|---|
| List servers | `list_servers` | Read-only; no side effects |
| Get server details | `get_server` | Read-only |
| Get resource usage | `get_server_resources` | Read-only |
| List files | `list_files` | Read-only |
| Read file contents | `read_file` | Read-only |
| List backups | `list_backups` | Read-only |
| Check backup status | `get_backup_status` | Read-only |
| List schedules | `list_schedules` | Read-only |
| Get build config | `get_build_config` | Read-only |
| Send console command (non-destructive) | `send_command` | Commands like `list`, `tps`, `say` are non-destructive |
| Get console output | `get_console_output` | Read-only |
| Get player count | `get_player_count` | Read-only (internally sends `list` command) |
| Start server | `start_server` | Safe — starting is always permissible |
| Restart server | `restart_server` | Safe — graceful restart is a normal operation |
| Create backup | `create_backup` | Safe — creating backups has no negative side effects |
| Write config files | `write_file` | Safe for non-critical files; logged for audit |
| Upload mod JARs | `upload_file` | Safe — files are written but server must be restarted to load them |

### 1.2 Gated (Requires Explicit Confirmation)

Operations that are destructive, potentially disruptive, or affect server availability. Aegis may only execute these when the `confirm: true` parameter is explicitly provided. In the deployment lifecycle, this confirmation is provided by the admin's button-click approval; in direct admin commands, it is implied by the admin's invocation.

| Operation | MCP Tool | Risk | Confirmation Mechanism |
|---|---|---|---|
| Kill server (force stop) | `kill_server` | Data loss, world corruption | `confirm: true` in tool params |
| Delete files | `delete_files` | Irreversible file removal | `confirm: true` in tool params |
| Restore backup (non-truncate) | `restore_backup` | Replaces server files with backup state | `confirm: true` in tool params |
| Restore backup (truncate) | `restore_backup` | **Wipes ALL files before restoring** | `confirm: true` AND `confirm_truncate: true` (double-confirm) |
| Stop server | `stop_server` | Disrupts players | Implicit confirmation from deployment lifecycle; explicit `confirm` for standalone stops |
| Update build config | `update_build_config` | Changes resource allocations | `confirm: true` in tool params |
| Execute schedule | `execute_schedule` | May trigger restart/backup operations | `confirm: true` in tool params |

### 1.3 Excluded (Never Exposed via MCP)

Operations that are too dangerous or inappropriate for autonomous execution. These endpoints are NOT wrapped as MCP tools and Aegis has no way to invoke them, even with confirmation.

| Operation | Pterodactyl Endpoint | Rationale |
|---|---|---|
| Create user | `POST /api/application/users` | User provisioning is a manual admin task; autonomous user creation risks privilege escalation |
| Modify user | `PATCH /api/application/users/{id}` | Changing admin status or permissions is a security-critical operation |
| Delete user | `DELETE /api/application/users/{id}` | Irreversible; could lock out legitimate admins |
| Create server | `POST /api/application/servers` | Server provisioning requires careful resource planning |
| Delete server | `DELETE /api/application/servers/{id}` | Irreversible data loss of all server files |
| Force delete server | `DELETE /api/application/servers/{id}/{force}` | Bypasses safety checks |
| Reinstall server | `POST /api/application/servers/{id}/reinstall` | Wipes all server data |
| Suspend server | `POST /api/application/servers/{id}/suspend` | Denies service; should only be manual admin action |
| Unsuspend server | `POST /api/application/servers/{id}/unsuspend` | Re-enables service after suspension; manual review needed |
| Create client API key | `POST /api/client/account/api-keys` | Expands attack surface; new key may have unintended permissions |
| Delete client API key | `DELETE /api/client/account/api-keys/{id}` | Could lock Aegis out of its own credentials |
| Manage allocations | `POST /api/application/nodes/{id}/allocations` | Network configuration affects other servers on the same node |
| Delete allocation | `DELETE /api/application/allocations/{id}` | Could disrupt active server connections |
| Manage subusers | `POST/PATCH/DELETE /api/client/servers/{id}/users/*` | Permission changes on servers are security-critical |
| Create database | `POST /api/application/servers/{id}/databases` | Database provisioning requires capacity planning |
| Delete database | `DELETE /api/application/servers/{id}/databases/{db}` | Irreversible data loss |

---

## 2. Credential Security Limits

### 2.1 Key Isolation

| Constraint | Implementation |
|---|---|
| Aegis never sees raw Pterodactyl API keys | Keys are stored encrypted in `ptero_credentials`; only the MCP server decrypts them |
| Application keys (`ptla_`) are used minimally | `keyScopeResolver.ts` prefers Client keys whenever a tool can operate in either mode |
| Keys are never logged | Regex redaction in all logging paths; `ptla_` and `ptlc_` prefixes are detected and masked |
| Keys are never exposed in Discord | Aegis cannot include API keys in any output; MCP tool results are filtered |
| Key rotation does not require restart | MCP server reloads credentials from DB on signal or when current key is flagged |
| Each Client key has explicit `server_scope` | If a key is scoped to server A, it cannot be used for operations on server B |
| Application keys have no per-server scope | This is a Pterodactyl limitation; Application keys access ALL servers. Use is minimized. |

### 2.2 Key Rotation Procedure

1. Admin adds new key to `ptero_credentials` via SQL or admin command
2. Admin signals the MCP server to reload (SIGUSR1 or NATS message)
3. MCP server loads the new key; marks it as active
4. Admin verifies the new key works via test tool invocation
5. Admin marks the old key as inactive in `ptero_credentials`
6. MCP server stops using the old key immediately

**Critical rule**: Never delete an old key until the new key is verified. Keys marked `is_active = false` are ignored but retained for audit history.

### 2.3 LLM Provider Key Isolation

LLM inference keys (Groq, OpenCode Zen) are managed separately in `api_keys` and are NOT accessible to the Pterodactyl MCP server. The MCP server has its own credential scope and cannot read or modify inference keys. This separation ensures that a compromise of the MCP server does not expose LLM provider keys.

---

## 3. Rate Limit & Throughput Limits

### 3.1 Pterodactyl API Limits

| Constraint | Value | Mitigation |
|---|---|---|
| Application API | 240 req/min/key | Track per-key; rotate across multiple keys; proactive throttle at 20 remaining |
| Client API | 240 req/min/key | Same as above |
| WebSocket command flood | No explicit limit, but Wings throttles | Client-side throttle: max 10 commands per 5 seconds |
| Backup creation | 1 concurrent backup per server | Check existing backups before creating; poll for completion |
| File upload | 100MB per file (default, configurable) | Validate file size before upload attempt; chunk large files or use alternative transfer |
| Maximum backups | Configurable per panel (default: 5) | Check backup count before creating; auto-delete oldest backup with admin consent |

### 3.2 Self-Imposed Limits

| Constraint | Value | Rationale |
|---|---|---|
| Maximum concurrent Pterodactyl API calls | 10 | Prevent overwhelming the panel |
| Minimum interval between list operations | 250ms | Avoid burst patterns when auto-paginating |
| Maximum file size for `write_file` tool | 5MB | Larger files should use `upload_file` |
| Maximum console buffer size | 200 lines | Prevent memory growth in WebSocket client |
| WebSocket idle timeout | 5 minutes after last subscriber leaves | Don't maintain connections nobody is using |
| Backup poll interval | 5 seconds | Balance between responsiveness and API load |
| Backup poll timeout | 10 minutes | Large servers may take time; don't wait forever |
| Player count command timeout | 10 seconds | `list` command should respond within seconds |
| Deployment execution timeout | 30 minutes | Entire deployment sequence must complete within 30 min |

---

## 4. Operational Safety Constraints

### 4.1 Deployment Safety

| Constraint | Implementation |
|---|---|
| **Backup before deploy** | The deployment lifecycle always creates a full backup before any file modification. If backup fails, the deployment is aborted. |
| **Zero-player gate** | Deployments only execute when player count is exactly 0. Admin force-deploy commands can override this. |
| **Single deployment per server** | PostgreSQL advisory locks ensure only one deployment can execute per server at a time. Concurrent attempts are queued. |
| **TPS validation** | After deployment, Aegis samples TPS three times over 30 seconds. If average TPS < 15, the deployment is considered failed and rollback is triggered. |
| **Automatic rollback** | If any deployment step fails, Aegis automatically restores from the pre-deployment backup. The backup UUID is recorded before any file operations begin. |
| **Staging validation** | All files are validated in the sandbox before being uploaded to the production server. Invalid JARs are rejected before deployment begins. |
| **In-game warning** | Before stopping the server, Aegis sends a 10-second warning via `say` command. Players are given time to save and disconnect. |

### 4.2 Console Command Safety

| Constraint | Implementation |
|---|---|
| **No `op` or `deop` commands** | The MCP server blocks commands matching `/^op\s/i` and `/^deop\s/i`. These should be manual admin actions. |
| **No `stop` via console** | Server stop should use the `stop_server` MCP tool (graceful), not `send_command` with `stop`. The tool includes proper state monitoring. |
| **Command rate limit** | Maximum 10 commands per 5-second window per server. Prevents command flooding. |
| **Command logging** | Every command sent via `send_command` is logged with timestamp, server ID, and correlation ID. |

### 4.3 File Operation Safety

| Constraint | Implementation |
|---|---|
| **Path traversal prevention** | All file paths are sanitized by `pathSanitizer.ts`. Paths containing `..` are rejected. Paths must be relative or rooted at `/`. |
| **Protected directories** | The MCP server rejects write/delete operations targeting: `/backups/`, `.env`, `/.ssh/` |
| **Protected file patterns** | The MCP server rejects operations on files matching: `*.jar.bak` (backup JARs), `server.properties.bak` |
| **File size validation** | Before upload, the MCP server validates that `file_size_bytes` matches the decoded base64 data. Mismatches are rejected. |
| **Atomic writes** | File writes use a write-then-rename pattern where possible (write to `.tmp` file, then rename to target). |

---

## 5. Sandbox Execution Limits

| Constraint | Value | Rationale |
|---|---|---|
| CPU limit | 2 cores | Prevents CPU-starving the host |
| Memory limit | 4 GB | Prevents OOM on host |
| Disk limit | 20 GB | Prevents disk exhaustion |
| Execution timeout | 30 minutes per task | No single task should run indefinitely |
| Command timeout | 10 minutes per command | Individual shell commands have a shorter ceiling |
| Network | Outbound only | No inbound connections to sandbox |
| User | Non-root (`aegis`, UID 1000) | No privilege escalation inside sandbox |
| Shells allowed | `/bin/bash`, `/bin/sh`, `/usr/bin/python3` | No unapproved interpreters |
| Blocked paths | `/etc/shadow`, `/root/.ssh`, host mounts | Sandbox boundary enforcement |
| Secret redaction | Regex for API keys, JWTs, private keys | Prevents secret leakage into logs or Discord |

---

## 6. MCP Protocol Safety

| Constraint | Implementation |
|---|---|
| **Schema validation** | All tool invocations are validated against the tool's `inputSchema` before execution. Invalid parameters are rejected with a descriptive error. |
| **Tool availability checks** | Before invoking a tool, Aegis checks `isAvailable` in the tool registry. If the MCP server's circuit breaker is open, the tool is marked unavailable. |
| **Timeout enforcement** | Every MCP tool invocation has a 60-second timeout. Long-running tools (like `create_backup`) have extended timeouts but still have ceilings. |
| **Error propagation** | MCP errors are never silently swallowed. Every error is logged and either retried (transient), escalated (credential/auth), or reported to the user (permanent). |
| **Circuit breaker** | If a MCP server fails 5 consecutive times, the circuit opens and all tools from that server are marked unavailable. Half-open probe after 30 seconds. |
| **No tool dynamic registration from Aegis** | Aegis cannot register new tools on the Pterodactyl MCP server. Only the MCP server's own code defines its tools. This prevents Aegis from bypassing safety gates by creating ungated tools. |

---

## 7. Audit & Accountability

### 7.1 Audit Logging Requirements

Every Pterodactyl operation is logged with:

| Field | Source |
|---|---|
| Timestamp | System clock |
| Correlation ID | IPC message envelope |
| Tool name | MCP `tools/call` method |
| Parameters (sanitized) | MCP tool input (secrets redacted) |
| Result status | MCP tool output (success/failure) |
| Credential ID used | From `keyScopeResolver` |
| Rate limit remaining | From `X-RateLimit-Remaining` header |
| Server ID | From tool parameters |
| Discord thread ID | From IPC metadata |
| Triggered by | `aegis` / `skill:{name}` / `admin:{discord_id}` |

### 7.2 Audit Log Retention

- Operational logs: 90 days
- Security events (auth failures, permission violations): 1 year
- Deployment audit trail: Indefinite (append-only)

### 7.3 Alert Escalation Matrix

| Event | Alert Channel | Urgency |
|---|---|---|
| Pterodactyl MCP server unreachable | Admin Discord channel + Aegis thread | High |
| All Pterodactyl credentials exhausted | Admin Discord channel | Critical |
| Deployment failure + rollback | Admin Discord channel + original forum thread | High |
| Rate limit exhaustion (all keys) | Admin Discord channel | Medium |
| Suspicious command pattern detected | Admin Discord channel | High |
| Sandbox resource limit breached | Aegis internal log | Low |
| MCP circuit breaker opened | Admin Discord channel | High |
| WebSocket JWT refresh failure | Aegis internal log | Medium |

---

## 8. Ambiguity & Known Limitation Register

| Item | Status | Resolution |
|---|---|---|
| **No native player count API** | Documented in 07_pterodactyl_research.md | Composite tool: `list` command + console output parsing. Fragile — depends on server output format. May break with Minecraft updates. |
| **Backup completion detection** | No webhook available | Polling with 5s interval. May consume API quota for large servers with slow backups. |
| **File upload size limits** | Per-panel configurable, not queryable via API | Attempt upload; handle 413 gracefully. Document the limit per deployment. |
| **WebSocket stats interval** | Not documented; empirically ~15s | Do not assume interval; handle events as they arrive. |
| **Application API key permission granularity** | Coarse and not fully documented | Assume full access for any Application key; minimize use; audit all invocations. |
| **Client API subuser permission mapping** | Not clearly documented | Test permissions at MCP server startup; mark unavailable tools when permissions are lacking. |
| **Concurrent backup limit** | Per-panel configurable | Check before creating; handle 422 "Backup limit reached" error. |
| **Pelican/Wings fork compatibility** | Pelican is a Pterodactyl fork with different API paths | The MCP server targets standard Pterodactyl v1.0+ API. Pelican compatibility may require a separate adapter. |
| **Pterodactyl v2 API** | Not yet released | Current design targets v1. When v2 is released, the MCP server must be updated. The MCP interface should remain stable; only the internal HTTP client needs changes. |

---

## 9. Operational Runbook Entries (Key Scenarios)

### 9.1 Adding a New Pterodactyl API Key

```sql
-- 1. Encrypt the key (application layer handles this)
INSERT INTO ptero_credentials (credential_type, encrypted_token, token_nonce, token_tag, token_hash, description, server_scope, permissions)
VALUES ('client', '<encrypted>', '<nonce>', '<tag>', '<sha256_hash>', 'Client Key - Survival', '["uuid-of-server-1"]'::JSONB, '{"control.console": true, "file.read": true, "file.write": true, "backup.create": true}'::JSONB);

-- 2. Signal MCP server to reload
-- Send SIGUSR1 to the pterodactyl-mcp process, or publish a NATS message to ptero-mcp.reload-credentials

-- 3. Verify
-- Have Aegis invoke list_servers or get_server_resources using the new key
```

### 9.2 Emergency Manual Rollback

If Aegis is unresponsive or the MCP server is down, admins can manually rollback:

1. Access the Pterodactyl panel directly
2. Navigate to the server → Backups
3. Find the backup named `pre-deploy-{job_id}`
4. Click Restore (with or without truncate)
5. Start the server
6. Verify TPS stability

### 9.3 Force-Starting a Stuck Deployment

If a deployment is stuck in `executing` state:

1. Check Aegis logs for the correlation ID
2. Check Pterodactyl MCP server logs for the last tool invocation
3. If the server is in a bad state, manually stop it via the panel
4. Restore from the backup referenced in `maintenance_queue.backup_uuid`
5. Mark the deployment as failed: `UPDATE maintenance_queue SET status = 'failed' WHERE job_id = '{id}'`
