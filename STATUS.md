# EdenVanguard — Project Status

> Accurate as of the consolidation commit (2026-10-09). This file replaced an
> outdated `memory.md` that still described "Phase 0" while the implementation
> had progressed well beyond it. Everything below reflects the actual code,
> not the blueprint.

## What is implemented

| Area | Status | Evidence |
|---|---|---|
| Monorepo scaffold (npm workspaces: shared → pterodactyl-mcp → vanguard → aegis) | done | root `package.json`, `tsconfig.base.json` |
| Aegis core loop (orchestrator → planner → executor → resultHandler → reporter) | done | `aegis/src/core/*` |
| Crash diagnostics (crashParser, logAnalyzer, diagnosticEngine) | done | `aegis/src/diagnostics/*` |
| Groq inference client (round-robin keys, 429 retry ×3, AES-256-GCM token decryption, rate-limit event recording) | done | `aegis/src/inference/client.ts` |
| MCP client layer (Aegis spawns pterodactyl-mcp over stdio; JSON-RPC 2.0) | done | `aegis/src/mcp/clientManager.ts` |
| Skill engine + runner + deduplication + admin review | done | `aegis/src/skills/*` |
| Cron / deployment pipeline (scheduler, deploymentManager, maintenance queue) | done | `aegis/src/cron/*` |
| Sandbox execution (child_process + ulimit/timeout hardening, dangerous-pattern blocking) | done — **child_process-based, NOT container-isolated** | `aegis/src/sandbox/executor.ts` |
| pterodactyl-mcp server (27 registered tools: server mgmt ×7, files ×7, backups ×5, console ×3, schedules ×2, application/build ×3) | done | `pterodactyl-mcp/src/tools/registry.ts` |
| Credential store (ptla_/ptlc_ scoping, AES-256-GCM at rest, SHA-256 lookup hash) | done | `pterodactyl-mcp/src/auth/*`, `aegis/src/db/schema.ts` (ptero_credentials) |
| Safety gates (Zod `confirm: true` for destructive ops, command blocker, path sanitizer, permission gates) | done | `pterodactyl-mcp/src/safety/*`, tool schemas |
| Rate limiting (per-key tracking) + auto-pagination + WebSocket client w/ JWT refresh | done | `pterodactyl-mcp/src/{rateLimiter,pagination,websocket}` |
| Vanguard Discord gateway (bot, event handlers, command registration, result listener) | done | `vanguard/src/gateway/*` |
| Vanguard detection (crashDetector, forumWatcher, pasteLinkExtractor) | done | `vanguard/src/detection/*` |
| Vanguard UI flows (buttons, checkbox builder, modals) + NATS IPC + Drizzle client | done | `vanguard/src/{ui,ipc,db}` |
| PostgreSQL schema (9 Aegis tables + 1 MCP-server table) + Drizzle migration 0000 | done | `aegis/src/db/schema.ts`, `infra/db/migrations/` |
| Unit tests: **116 across 4 workspaces** (shared 24, pterodactyl-mcp 26, aegis 45, vanguard 21) | done | `*/src/tests/*.test.ts` |
| CI (GitHub Actions: install → build → typecheck → test) | done | `.github/workflows/ci.yml` |

## What is NOT implemented (honest deltas vs blueprint docs)

- **Container-based sandbox isolation**: `docs/08_risks_and_limits.md §5` specifies
  Docker/cgroup limits; the code uses `child_process` with `ulimit` wrappers, command
  timeouts, output caps, and dangerous-pattern blocking instead. The resource-limit
  *interface* (`SandboxConfig`) exists and is enforced best-effort, but there is no
  hard container boundary.
- **Patch export / rollback verification (phase 10)**: `patches/` is empty (`.gitkeep`);
  no patch-generation pipeline is wired up.
- **Integration / e2e suites**: unit tests only. Live Discord gateway, NATS, PostgreSQL,
  Pterodactyl panel, and Groq API paths are exercised through interfaces/mocks, not
  end-to-end.
- **Phase 9–10 hardening polish**: dedup reviewer flow exists in code, but the full
  admin-review UX loop over Discord has no dedicated integration test.

## Verification status

- `npm ci` clean install
- `npm run build` (root, workspace dependency order) — exit 0
- `npx tsc --noEmit` per workspace (shared, pterodactyl-mcp, vanguard, aegis) — 0 errors
- `npm test` — 116/116 passing (pure unit tests; no live services required)
- `infra/docker/docker-compose.yml` — structurally valid (postgres 17-alpine + nats 2-alpine with healthchecks)
