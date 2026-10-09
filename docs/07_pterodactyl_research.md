# 07 — Pterodactyl API Research & Endpoint Mapping

This document summarizes the findings from a dedicated research pass against the official Pterodactyl Panel API documentation (v1.0+), the NETVPX community-maintained API reference, and the official Pterodactyl GitHub repository. It maps every relevant endpoint, separates Application API from Client API responsibilities, documents auth models and rate limits, identifies unsafe or deprecated endpoints, and derives concrete design implications for the MCP-native integration layer.

---

## 1. API Architecture Overview

Pterodactyl exposes two distinct REST API surfaces plus a WebSocket real-time stream:

| Surface | Base URL | Auth Prefix | Scope |
|---|---|---|---|
| **Application API** | `/api/application/` | `ptla_` | Admin-level panel management: users, servers, nodes, locations, nests, allocations, databases |
| **Client API** | `/api/client/` | `ptlc_` | Per-user server operations: console, files, backups, schedules, resources, subusers, databases |
| **WebSocket API** | `wss://{node}:{port}/api/servers/{uuid}/ws` | JWT (10-min expiry) | Real-time console output, power state, resource stats |

Both REST APIs use Bearer token authentication in the `Authorization` header and require `Accept: Application/vnd.pterodactyl.v1+json`. Responses follow a consistent JSON envelope:

```json
{
  "object": "list|server|user|...",
  "data": [ ... ] | { ... },
  "meta": {
    "pagination": {
      "total": 50,
      "count": 25,
      "per_page": 25,
      "current_page": 1,
      "total_pages": 2
    }
  }
}
```

---

## 2. Authentication Model

### 2.1 Application API Keys (`ptla_` prefix)

- Generated in the Admin Panel under **Application API**.
- Each key has a **description** and optionally **scoped IP whitelist** and **permission bits** (read/write for users, servers, nodes, locations, nests, allocations, databases).
- **Full admin access by default** — permission scoping is opt-in and coarse-grained. A key with "servers:read,write" can create, modify, suspend, unsuspend, reinstall, and delete any server on the panel.
- There is **no per-server scoping** for Application API keys. A key that can read servers can read ALL servers.
- Keys are long-lived (no automatic expiry). Rotation is manual.

### 2.2 Client API Keys (`ptlc_` prefix)

- Generated in the user's Account panel under **API Credentials**.
- Each key is bound to the user who created it.
- The key inherits the user's server permissions (owner + subuser permissions).
- A Client API key can only operate on servers the associated user has access to.
- **Permission model**: Each server has granular permissions for subusers (e.g., `control.console`, `control.start`, `file.read`, `file.write`, `backup.create`, `schedule.read`, etc.).
- Keys are long-lived. No automatic expiry.

### 2.3 WebSocket JWT Tokens

- Obtained via `GET /api/client/servers/{server}/websocket` using a Client API key.
- Returns a JWT token and a WebSocket URL pointing to the Wings daemon (not the panel).
- **JWT expires after 10 minutes**. Must be refreshed periodically by re-calling the websocket endpoint.
- The JWT is signed with a node-specific key and encodes server UUID, user permissions, and user identity.
- Required permission: `websocket.connect`.

### 2.4 Design Implications

- **Aegis must use BOTH key types**: Application API for admin-level operations (listing all servers, managing allocations), Client API for server-specific operations (files, console, backups, schedules).
- **Credential storage must distinguish key types** — `ptla_` vs `ptlc_` keys have fundamentally different permission scopes and must not be used interchangeably.
- **WebSocket JWT refresh must be automated** — the 10-minute expiry requires a refresh loop that obtains a new token before the current one expires.
- **The Application API key is an extremely high-value secret** — it grants full panel access. It must be encrypted at rest, never logged, and its use must be strictly limited to operations that genuinely require admin scope.

---

## 3. Rate Limiting

### 3.1 Limits

| API | Default Limit | Configurable |
|---|---|---|
| Application API | 240 requests/minute/key | Yes (`APP_API_APPLICATION_RATELIMIT` in `.env`) |
| Client API | 240 requests/minute/key | Yes (`APP_API_CLIENT_RATELIMIT` in `.env`) |
| WebSocket | No explicit rate limit | N/A (but Wings may throttle command floods) |

### 3.2 Rate Limit Headers

Every response includes:

```
X-RateLimit-Limit: 240
X-RateLimit-Remaining: 237
X-RateLimit-Reset: 1640995200
```

### 3.3 429 Response

```json
{
  "errors": [
    {
      "code": "TooManyRequestsHttpException",
      "status": "429",
      "detail": "Too many requests, please slow down."
    }
  ]
}
```

### 3.4 Design Implications

- The MCP server must track `X-RateLimit-Remaining` on every response and proactively throttle before hitting 0.
- With 240 req/min (~4 req/sec), batch file operations must be paced. A 50-file mod deployment could consume the entire minute's budget if done naively.
- The system should maintain multiple API keys per scope (Application and Client) and rotate between them to increase throughput, reusing the `get_next_valid_key()` pattern from the existing `api_keys` table.
- WebSocket operations (console streaming, command sending) do not consume REST API rate limits, making the WebSocket the preferred channel for interactive operations.

---

## 4. Pagination

All list endpoints paginate with the following query parameters:

| Parameter | Default | Description |
|---|---|---|
| `page` | 1 | Current page number |
| `per_page` | 25 | Items per page (server-side cap varies) |

Pagination metadata in response:

```json
{
  "meta": {
    "pagination": {
      "total": 50,
      "count": 25,
      "per_page": 25,
      "current_page": 1,
      "total_pages": 2
    }
  }
}
```

**Design implication**: The MCP server must handle pagination transparently. Tools like `list_all_servers` or `list_directory` must auto-paginate and return complete result sets to Aegis, rather than forcing Aegis to understand pagination semantics.

---

## 5. Application API Endpoint Map

### 5.1 User Management

| Method | Endpoint | Purpose | MCP Priority |
|---|---|---|---|
| GET | `/api/application/users` | List all users (paginated) | Low |
| GET | `/api/application/users/{id}` | Get user details | Low |
| GET | `/api/application/users/external/{external_id}` | Get user by external ID | Low |
| POST | `/api/application/users` | Create user | **Excluded** (unsafe) |
| PATCH | `/api/application/users/{id}` | Update user | **Excluded** (unsafe) |
| DELETE | `/api/application/users/{id}` | Delete user | **Excluded** (unsafe) |

**Exclusion rationale**: User creation, modification, and deletion are panel administration operations that should never be performed autonomously by Aegis. These must remain manual admin actions.

### 5.2 Server Management

| Method | Endpoint | Purpose | MCP Priority |
|---|---|---|---|
| GET | `/api/application/servers` | List all servers | High |
| GET | `/api/application/servers/{id}` | Get server details | High |
| POST | `/api/application/servers` | Create server | **Excluded** |
| PATCH | `/api/application/servers/{id}/details` | Update server details | **Excluded** |
| PATCH | `/api/application/servers/{id}/build` | Update build config (resources) | Medium |
| PATCH | `/api/application/servers/{id}/startup` | Update startup command/variables | Medium |
| POST | `/api/application/servers/{id}/suspend` | Suspend server | **Gated** |
| POST | `/api/application/servers/{id}/unsuspend` | Unsuspend server | **Gated** |
| POST | `/api/application/servers/{id}/reinstall` | Reinstall server | **Excluded** |
| DELETE | `/api/application/servers/{id}` | Delete server | **Excluded** |
| DELETE | `/api/application/servers/{id}/{force}` | Force delete server | **Excluded** |

**Gated rationale**: Suspend/unsuspend are potentially useful for emergency maintenance but must require explicit admin confirmation. Build and startup modifications are useful for the proactive health feature but must be permission-gated.

### 5.3 Node Management

| Method | Endpoint | Purpose | MCP Priority |
|---|---|---|---|
| GET | `/api/application/nodes` | List all nodes | Low |
| GET | `/api/application/nodes/{id}` | Get node details | Low |
| GET | `/api/application/nodes/{id}/configuration` | Get Wings config | Low |
| GET | `/api/application/nodes/{id}/allocations` | List allocations | Medium |
| POST | `/api/application/nodes/{id}/allocations` | Create allocations | **Gated** |
| DELETE | `/api/application/allocations/{id}` | Delete allocation | **Excluded** |

### 5.4 Location, Nest, Egg Management

| Priority | Rationale |
|---|---|
| **Low / Excluded** | These are infrastructure provisioning endpoints. Aegis does not provision nodes, locations, or nests. Read-only access may be useful for context but is not critical. |

### 5.5 Database Management

| Method | Endpoint | Purpose | MCP Priority |
|---|---|---|---|
| GET | `/api/application/servers/{id}/databases` | List server databases | Low |
| POST | `/api/application/servers/{id}/databases` | Create database | **Excluded** |
| DELETE | `/api/application/servers/{id}/databases/{db}` | Delete database | **Excluded** |

---

## 6. Client API Endpoint Map

### 6.1 Account Management

| Method | Endpoint | Purpose | MCP Priority |
|---|---|---|---|
| GET | `/api/client/account` | Get account details | Low |
| GET | `/api/client/account/api-keys` | List API keys | Low |
| POST | `/api/client/account/api-keys` | Create API key | **Excluded** |
| DELETE | `/api/client/account/api-keys/{id}` | Delete API key | **Excluded** |

### 6.2 Server Management

| Method | Endpoint | Purpose | MCP Priority |
|---|---|---|---|
| GET | `/api/client` | List accessible servers | High |
| GET | `/api/client/servers/{id}` | Get server details | High |
| GET | `/api/client/servers/{id}/resources` | Get resource usage | **Critical** |
| POST | `/api/client/servers/{id}/power` | Power signal (start/stop/restart/kill) | **Critical** |
| POST | `/api/client/servers/{id}/command` | Send console command | **Critical** |

**Resource usage response**:
```json
{
  "attributes": {
    "current_state": "running",
    "resources": {
      "memory_bytes": 134217728,
      "cpu_absolute": 2.5,
      "disk_bytes": 50331648,
      "network": {
        "rx_bytes": 1024,
        "tx_bytes": 2048
      }
    }
  }
}
```

**Note**: The Client API `/resources` endpoint does NOT directly return player count. Player count must be derived from WebSocket stats events or console command output (e.g., running `list` and parsing the response). This is an important ambiguity — there is no canonical "player count" API.

### 6.3 File Management

| Method | Endpoint | Purpose | MCP Priority |
|---|---|---|---|
| GET | `/api/client/servers/{id}/files/list` | List directory | **Critical** |
| GET | `/api/client/servers/{id}/files/contents` | Read file | **Critical** |
| POST | `/api/client/servers/{id}/files/write` | Write file | **Critical** |
| POST | `/api/client/servers/{id}/files/upload` | Get upload URL | **Critical** |
| GET | `/api/client/servers/{id}/files/download` | Get download URL | High |
| POST | `/api/client/servers/{id}/files/create-folder` | Create directory | Medium |
| POST | `/api/client/servers/{id}/files/rename` | Rename files | High |
| POST | `/api/client/servers/{id}/files/copy` | Copy file | Medium |
| POST | `/api/client/servers/{id}/files/delete` | Delete files | **Gated** |
| POST | `/api/client/servers/{id}/files/compress` | Compress files | Low |
| POST | `/api/client/servers/{id}/files/decompress` | Decompress archive | Low |

**File upload flow**: The upload endpoint returns a signed URL. The actual file data is then PUT to that URL. This is a two-step process that the MCP server must handle internally — Aegis should see a single `upload_file` tool, not the raw two-step flow.

**File size limits**: The Pterodactyl panel enforces upload size limits (configurable, typically 100MB). Large mod JARs should be validated before upload attempts.

**Path traversal risk**: File paths must be sanitized to prevent directory traversal. The API rejects paths containing `..` but the MCP layer should also validate.

### 6.4 Backup Management

| Method | Endpoint | Purpose | MCP Priority |
|---|---|---|---|
| GET | `/api/client/servers/{id}/backups` | List backups | High |
| POST | `/api/client/servers/{id}/backups` | Create backup | **Critical** |
| GET | `/api/client/servers/{id}/backups/{bk}` | Get backup status | **Critical** |
| GET | `/api/client/servers/{id}/backups/{bk}/download` | Get download URL | Medium |
| POST | `/api/client/servers/{id}/backups/{bk}/restore` | Restore backup | **Critical** (gated) |
| DELETE | `/api/client/servers/{id}/backups/{bk}` | Delete backup | **Gated** |

**Backup creation is asynchronous**: The POST returns immediately with status `processing`. The backup's `checksum` and `bytes` fields are populated only after completion. The MCP server must poll the backup status endpoint or use the WebSocket to monitor completion.

**Restore operation**: The restore endpoint accepts `{ "truncate": true }` to wipe all files before restoring. This is extremely dangerous. The MCP tool must require explicit admin confirmation and must never default to `truncate: true`.

**Backup limit**: Pterodactyl enforces a maximum backup count per server (configurable). The MCP server should check available slots before creating backups.

### 6.5 Scheduled Tasks

| Method | Endpoint | Purpose | MCP Priority |
|---|---|---|---|
| GET | `/api/client/servers/{id}/schedules` | List schedules | Medium |
| POST | `/api/client/servers/{id}/schedules` | Create schedule | Medium |
| GET | `/api/client/servers/{id}/schedules/{sch}` | Get schedule details | Medium |
| POST | `/api/client/servers/{id}/schedules/{sch}` | Update schedule | Medium |
| DELETE | `/api/client/servers/{id}/schedules/{sch}` | Delete schedule | **Gated** |
| POST | `/api/client/servers/{id}/schedules/{sch}/execute` | Trigger schedule | Medium |

**Schedule structure**: Each schedule contains tasks. Each task has an action (`command`, `power`, `backup`) and a payload. This is useful for Aegis to programmatically set up maintenance schedules (e.g., "restart every Sunday at 3 AM if no players online").

### 6.6 Network & Allocations

| Method | Endpoint | Purpose | MCP Priority |
|---|---|---|---|
| GET | `/api/client/servers/{id}/network/allocations` | List allocations | Low |
| POST | `/api/client/servers/{id}/network/allocations` | Assign allocation | **Excluded** |
| POST | `/api/client/servers/{id}/network/allocations/{alloc}/primary` | Set primary | **Excluded** |

### 6.7 Subuser Management

| Method | Endpoint | Purpose | MCP Priority |
|---|---|---|---|
| GET | `/api/client/servers/{id}/users` | List subusers | Low |
| POST | `/api/client/servers/{id}/users` | Create subuser | **Excluded** |
| PATCH | `/api/client/servers/{id}/users/{uid}` | Update subuser | **Excluded** |
| DELETE | `/api/client/servers/{id}/users/{uid}` | Delete subuser | **Excluded** |

---

## 7. WebSocket API Detail

### 7.1 Connection Flow

1. `GET /api/client/servers/{id}/websocket` → Obtain JWT + WSS URL
2. Connect to `wss://{node}:{port}/api/servers/{uuid}/ws`
3. Send auth message: `{ "event": "auth", "args": ["<jwt>"] }`
4. Receive auth success: `{ "event": "auth success" }`
5. Begin receiving events

### 7.2 Client → Server Events

| Event | Args | Description |
|---|---|---|
| `auth` | `[jwt_token]` | Authenticate the connection |
| `send command` | `[command_string]` | Send a console command |
| `set state` | `["start"\|"stop"\|"restart"\|"kill"]` | Change power state |

### 7.3 Server → Client Events

| Event | Args | Description |
|---|---|---|
| `auth success` | `[]` | Authentication succeeded |
| `console output` | `[line]` | Console output line |
| `status` | `["running"\|"starting"\|"stopping"\|"offline"]` | Power state change |
| `stats` | `[json_string]` | Resource usage (periodic, ~15s interval) |
| `jwt error` | `[error_message]` | JWT expired or invalid |
| `daemon message` | `[message]` | Wings daemon notification |
| `transfer logs` | `[log_line]` | Server transfer logs |
| `install output` | `[line]` | Installation process output |
| `transfer status` | `[status]` | Server transfer status |

### 7.4 Stats Payload (from `stats` event)

```json
{
  "memory_bytes": 134217728,
  "memory_limit_bytes": 1073741824,
  "cpu_absolute": 2.5,
  "network": {
    "rx_bytes": 1024,
    "tx_bytes": 2048
  },
  "uptime": 3600,
  "state": "running",
  "disk_bytes": 50331648
}
```

**Critical observation**: The `stats` payload does NOT include player count. This is consistent with the REST API. Player count derivation strategies:
1. Send `list` command via WebSocket, parse the response from `console output`
2. Use a Spark plugin's API endpoint (if installed)
3. Parse the server's `server.properties` or log files for recent join/leave events

### 7.5 JWT Refresh Strategy

The 10-minute JWT expiry requires proactive refresh:

- Refresh at **8 minutes** (2-minute safety margin)
- On `jwt error` event: immediately refresh and reconnect
- On WebSocket close code 4004: token expired, refresh and reconnect
- Maximum 5 reconnect attempts with exponential backoff

---

## 8. Error Response Format

All API errors follow a consistent format:

```json
{
  "errors": [
    {
      "code": "NotFoundHttpException",
      "status": "404",
      "detail": "The requested resource could not be found."
    }
  ]
}
```

Common error codes:

| HTTP Status | Code | Meaning | Recovery |
|---|---|---|---|
| 400 | `BadRequestHttpException` | Invalid request body/params | Fix parameters, retry |
| 401 | — | Invalid or missing API key | Check key, rotate if compromised |
| 403 | `ForbiddenAccessException` | Insufficient permissions | Escalate to admin or use Application key |
| 404 | `NotFoundHttpException` | Resource not found | Verify IDs, check if deleted |
| 409 | `Conflict` | State conflict (e.g., server already running) | Check current state, adjust request |
| 422 | `ValidationError` | Invalid input data | Fix validation errors |
| 429 | `TooManyRequestsHttpException` | Rate limit exceeded | Back off, check `Retry-After` |
| 500 | — | Internal server error | Retry with backoff (transient) |

---

## 9. Endpoints Explicitly Excluded from MCP Wrapping

The following endpoints are **unsafe for autonomous agent use** and must NOT be exposed as MCP tools:

| Endpoint | Reason |
|---|---|
| `POST /api/application/users` | Creating users autonomously risks privilege escalation |
| `PATCH /api/application/users/{id}` | Modifying user admin status is a security risk |
| `DELETE /api/application/users/{id}` | Irreversible; could lock out admins |
| `POST /api/application/servers` | Server provisioning should be manual |
| `DELETE /api/application/servers/{id}` | Irreversible data loss |
| `DELETE /api/application/servers/{id}/{force}` | Forced deletion bypasses safety checks |
| `POST /api/application/servers/{id}/reinstall` | Wipes all server data |
| `POST /api/client/account/api-keys` | Creating Client API keys programmatically expands attack surface |
| `DELETE /api/client/account/api-keys/{id}` | Could lock Aegis out of its own credentials |
| All allocation assignment/deletion | Network configuration should be manual |
| All subuser management | Permission changes should be manual |
| `POST /api/client/servers/{id}/backups/{bk}/restore` with `truncate: true` | Must be gated behind explicit admin confirmation |
| `POST /api/client/servers/{id}/files/delete` | Must be gated — file deletion in production is dangerous |

---

## 10. Ambiguities & Gaps in Official Documentation

| Ambiguity | Resolution |
|---|---|
| **Player count not available via API** | No REST or WebSocket event directly provides player count. Must be derived from console command output. The MCP server will implement a `get_player_count` tool that sends `list` via WebSocket and parses the response. |
| **Backup completion detection** | No webhook for backup completion. Must poll the `GET /api/client/servers/{id}/backups/{bk}` endpoint or monitor WebSocket `daemon message` events. The MCP server will poll with 5-second intervals, up to 10 minutes. |
| **File upload size limits** | Configurable per-panel, not exposed via API. The MCP server will attempt uploads and handle 413 errors gracefully, falling back to chunked upload or admin notification. |
| **WebSocket stats interval** | Documentation says "periodic" but does not specify the interval. Empirically ~15 seconds. The MCP server should not assume a specific interval but handle stats events as they arrive. |
| **Concurrent backup limit** | The panel enforces a maximum number of backups per server (configurable, default varies). The MCP server should check via `GET /api/client/servers/{id}/backups` before attempting creation. |
| **Application API key permissions granularity** | The documentation does not clearly document all permission bits. The safest approach is to assume any Application API key has full access and to minimize its use. |
| **Client API key subuser permission resolution** | It is unclear exactly which subuser permissions map to which API endpoints. The MCP server should test permission availability at startup and mark unavailable tools accordingly. |
| **Wings daemon API** | There is a separate Wings daemon REST API (`/api/servers/{uuid}/...`) that the panel proxies to. Some operations may go directly to Wings in the WebSocket flow. The MCP server should not interact with Wings directly — all operations must go through the panel API. |
| **Rate limit per IP vs per key** | Documentation states "per API key" but some panel configurations may also enforce per-IP limits. The MCP server should monitor for unexpected 429s and implement backoff regardless. |

---

## 11. MCP Integration Design Implications

Based on the research findings, the MCP server wrapping Pterodactyl must implement the following architectural decisions:

1. **Dual credential modes**: The MCP server must support both `ptla_` (Application) and `ptlc_` (Client) API keys as separate credential configurations. Tools that require admin scope use `ptla_` keys; tools that operate on specific servers use `ptlc_` keys.

2. **Credential scoping layer**: Every MCP tool invocation must first check whether the configured credentials support the required operation. If a `ptlc_` key lacks the `backup.create` permission for the target server, the tool must return a clear error rather than making a doomed API call.

3. **WebSocket lifecycle management**: The MCP server must own the WebSocket connection lifecycle — obtaining JWTs, maintaining connections, handling refresh, and exposing high-level events (console output, status changes, stats) as MCP tool results or resources.

4. **Pagination abstraction**: List-style tools must auto-paginate and return complete results. Aegis should never need to handle pagination directly.

5. **Async operation polling**: Backup creation and server startup are asynchronous. The MCP server must poll for completion and return final results, rather than returning intermediate "processing" states to Aegis.

6. **Player count derivation**: Since there is no native player count API, the MCP server must implement a composite tool that uses the WebSocket `send command` + `console output` flow to run `list` and parse the player count.

7. **Rate limit awareness**: The MCP server must track remaining requests per key and proactively throttle or rotate keys before hitting limits.

8. **Dangerous operation gating**: Restore, delete, suspend, and kill operations must require an explicit `confirm: true` parameter. The MCP server must refuse these operations without confirmation, even if Aegis requests them.
