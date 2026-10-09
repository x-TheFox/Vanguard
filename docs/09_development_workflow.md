# 09 — Development Workflow, Commit Discipline & Patch Export

This document defines the mandatory development workflow for the EdenVanguard project. It covers repository initialization, branch strategy, commit standards, code style enforcement, the patch export process, and backup/recovery procedures. Every contributor must follow these rules; they are not optional guidelines.

---

## A. Repository Initialization

### A.1 Git Init & Remote

The monorepo root is initialized as a single Git repository containing all three packages (`vanguard/`, `aegis/`, `pterodactyl-mcp/`), the `shared/` library, the `infra/` directory, and the `docs/` blueprint directory.

```bash
mkdir edenvanguard && cd edenvanguard
git init
git remote add origin <repository-url>
```

A single-repo (monorepo) approach is chosen over a multi-repo approach for the following reasons:

- **Atomic cross-package changes**: When a shared type in `shared/types/ipc.ts` changes, the corresponding changes in Vanguard, Aegis, and the Pterodactyl MCP server must be committed together. Multi-repo setups require coordinated PRs across repositories, which is error-prone and makes bisecting regressions difficult.
- **Simplified versioning**: All packages share a single version history. There is no risk of Vanguard running against an incompatible Aegis version because both are always built from the same commit.
- **Simplified CI/CD**: A single pipeline tests the entire system, rather than requiring cross-repo trigger chains.
- **Patch export coherence**: The patch series (Section C) must represent the complete system evolution. A monorepo guarantees this; a multi-repo setup would require merging patch series from multiple sources.

### A.2 Branch Strategy

The repository uses a three-tier branching model:

| Branch | Purpose | Protection | Merge Policy |
|---|---|---|---|
| `main` | Production-ready code. Every commit on `main` must pass the full test suite and represent a deployable state. | **Protected**: no force-push, no direct commits, require PR review, require CI pass | Only via merge from `develop` after full validation |
| `develop` | Integration branch. All feature branches merge here first. CI runs on every push. | **Protected**: no force-push, require CI pass | Merge from feature branches; squash-merge to `main` |
| `feature/*` | Individual feature branches. One branch per logical unit of work. | None (short-lived) | Delete after merge to `develop` |

**Branch naming conventions:**

```
feature/phase-0-scaffolding
feature/phase-1-ptero-mcp-auth
feature/phase-1-ptero-mcp-websocket
feature/phase-2-ptero-mcp-tools
feature/phase-3-vanguard-gateway
feature/phase-4-aegis-core-mcp-client
feature/phase-5-crash-diagnostics
feature/phase-6-suggestion-dedup
feature/phase-7-deployment-pipeline
feature/phase-8-dynamic-skills
feature/phase-9-polish-hardening
feature/phase-10-release-engineering
hotfix/critical-bug-description
```

**Branch protection rules:**

- `main`: Require 1 approving review, require status checks to pass, require signed commits, no force push, no deletion
- `develop`: Require status checks to pass, no force push, require signed commits

### A.3 `.gitignore` Requirements

The `.gitignore` file must be created at the monorepo root with the following mandatory entries:

```gitignore
# ── Dependencies ──
node_modules/
**/node_modules/

# ── Build outputs ──
dist/
build/
*.js.map
*.d.ts.map
*.tsbuildinfo

# ── Environment & secrets ──
.env
.env.local
.env.*.local
**/.env
**/.env.local
# NEVER commit raw API keys, tokens, or encryption keys

# ── IDE ──
.vscode/
.idea/
*.swp
*.swo
*~
.DS_Store

# ── Sandbox artifacts ──
workspace/
staging/
downloads/
*.jar

# ── Database ──
*.sql.bak
pg_dump/

# ── Patches (generated, not source) ──
patches/

# ── Logs ──
*.log
logs/

# ── Coverage ──
coverage/
.nyc_output/

# ── Docker volumes ──
docker-data/

# ── Encryption key files (NEVER commit) ──
*.pem
*.key
encryption_key*
```

**Critical rule**: Files containing secrets (`.env`, `.pem`, `.key`) must NEVER appear in the repository history. If a secret is accidentally committed, the commit must be rewritten (force-push to `develop` only) and the exposed secret must be rotated immediately. The `.gitignore` is the first line of defense but not the only one — pre-commit hooks (Section A.4) provide a second layer.

### A.4 Code Style Enforcement

Code style is enforced through automated tooling that runs on every commit and CI pipeline:

**TypeScript / Node.js:**

- **ESLint** with `@typescript-eslint/recommended` + strict rules
- **Prettier** with the following configuration (in `package.json` at root):

```json
{
  "prettier": {
    "semi": true,
    "singleQuote": true,
    "trailingComma": "all",
    "printWidth": 100,
    "tabWidth": 4,
    "arrowParens": "always"
  }
}
```

- **Pre-commit hook**: `lint-staged` runs ESLint and Prettier on staged files before allowing the commit. This prevents unstyled code from entering the repository.

**Formatting rules (non-negotiable):**

1. All TypeScript files use 4-space indentation (no tabs)
2. All files end with a newline
3. No trailing whitespace
4. Import order: Node builtins → external packages → internal modules (enforced by `eslint-plugin-import`)
5. All public functions and interfaces must have JSDoc comments
6. No `any` types — use `unknown` and type guards, or explicit type assertions with justification comments

**Pre-commit hook setup (via `husky` + `lint-staged`):**

```json
{
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.{json,md,yml,yaml}": ["prettier --write"],
    "*.sql": ["prettier --write"]
  }
}
```

Additionally, a **secret detection hook** scans staged files for patterns matching API keys (`ptla_`, `ptlc_`, `sk-`, `xai-`, `gsk_`) and blocks the commit if any are found:

```bash
# .husky/pre-commit
if git diff --cached | grep -iE '(ptla_|ptlc_|sk-|xai-|gsk_|ENCRYPTION_KEY)'; then
    echo "ERROR: Potential secret detected in staged files. Remove it before committing."
    exit 1
fi
```

---

## B. Commit Discipline

### B.1 Commit Rules

Every commit in the repository must satisfy the following requirements:

1. **Complete logical unit**: Each commit must represent one coherent change that leaves the codebase in a working state. A commit must never introduce a broken build, failing tests, or incomplete features. If a change spans multiple files, all files are included in a single commit rather than spread across partial commits.

2. **No WIP commits**: Commits marked "WIP", "in progress", "fix later", or similar are prohibited. If work is incomplete at the end of a session, it stays on the feature branch (unpushed) until it is completed. The `git stash` command exists for this purpose.

3. **Architectural reasoning**: The commit message body must explain *why* the change was made, not just *what* was changed. The diff itself shows what changed; the commit message provides the reasoning that the diff cannot convey. This is critical for future developers who need to understand design decisions during code archaeology.

4. **Implementation reasoning**: For non-obvious implementation choices (e.g., choosing one algorithm over another, using a specific library, structuring code in a particular way), the commit message must document the trade-offs considered and the rationale for the chosen approach.

### B.2 Commit Message Format

All commit messages follow the Conventional Commits specification:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**

| Type | Usage |
|---|---|
| `feat` | New feature or significant enhancement |
| `fix` | Bug fix |
| `refactor` | Code restructuring without behavior change |
| `test` | Adding or updating tests |
| `docs` | Documentation changes |
| `chore` | Build, tooling, dependency changes |
| `perf` | Performance improvement |
| `ci` | CI/CD pipeline changes |

**Scopes:**

| Scope | Package/Area |
|---|---|
| `database` | Schema, migrations, SQL functions |
| `mcp` | MCP client in Aegis |
| `pterodactyl-mcp` | Pterodactyl MCP server |
| `vanguard` | Discord gateway layer |
| `aegis` | Autonomous intelligence core |
| `skills` | Dynamic skill engine |
| `deployment` | Deployment pipeline and cron |
| `sandbox` | VM sandbox and shell execution |
| `inference` | LLM inference client and key management |
| `infra` | Docker, scripts, infrastructure |
| `crypto` | Encryption utilities |

### B.3 Example Commit Progression

The following shows the expected commit history for the project, from initialization through release:

```
chore: initialize monorepo structure

Set up the edenvanguard/ directory with package.json, tsconfig.json,
and .gitignore for each package (vanguard, aegis, pterodactyl-mcp, shared).
Create the docs/ directory with the architecture blueprint.
Configure ESLint, Prettier, and lint-staged at the root level.

Reasoning: Monorepo chosen over multi-repo to ensure atomic cross-package
commits and coherent patch series export. All packages share the same
tooling configuration for consistency.

feat(database): add PostgreSQL schema with ptero_credentials table

Implement the full DDL from 02_database_schema.sql including api_keys,
ptero_credentials (with AES-256-GCM encrypted token storage, token_hash
for dedup, JSONB server_scope and permissions), suggestion_threads,
maintenance_queue, deployment_audit, rate_limit_events, skill_registry,
and cron_jobs. Add the get_next_valid_key() function with FOR UPDATE
SKIP LOCKED for concurrent-safe round-robin key rotation. Add dedicated
ptero_mcp_app role with no DELETE grant on ptero_credentials to enforce
audit trail preservation of inactive keys.

Reasoning: The ptero_credentials table is separated from api_keys to
enforce credential isolation — the Pterodactyl MCP server can only read
its own credentials, not LLM provider keys, and vice versa. The
token_hash column enables duplicate key detection without decrypting
every stored token, which is important for performance when the key
pool grows.

feat(mcp): implement MCP client manager

Add mcpClientManager.ts with tool discovery (tools/list), invocation
(tools/call), resource subscription, and circuit breaker integration.
Implement stdio and SSE transports. Add toolRegistry.ts for unified
tool lookup across builtin, skill, and MCP sources. Add authDelegate.ts
that delegates credential resolution to MCP servers.

Reasoning: The MCP client manager is the sole interface through which
Aegis accesses external tools. By centralizing all tool invocations
through this layer, we guarantee that Aegis never directly calls any
Pterodactyl REST endpoint — the MCP purity constraint is enforced at
the architectural level, not just by convention.

feat(pterodactyl-mcp): implement auth subsystem

Add credentialStore.ts for loading ptla_/ptlc_ keys from ptero_credentials
with AES-256-GCM decryption and in-memory caching. Add keyScopeResolver.ts
for mapping tool names to required key types. Add rateLimitTracker.ts
with proactive throttling at 20 remaining requests. Add tokenRefresh.ts
for 8-minute JWT refresh loop on WebSocket connections.

Reasoning: The auth subsystem is the security boundary between Aegis
and the Pterodactyl API. By centralizing key selection, rate limiting,
and JWT management in the MCP server, we ensure that Aegis never handles
raw Pterodactyl credentials and that rate limit exhaustion on one key
automatically rotates to the next available key.

feat(pterodactyl-mcp): implement WebSocket manager

Add websocketClient.ts with JWT auth, event handling (console output,
status, stats, jwt error), reconnection with exponential backoff, and
a circular console buffer of 200 lines. Implement the WSConnectionPool
for managing multiple server connections with idle timeout and JWT
refresh. Expose console stream and resource stats as MCP resources.

Reasoning: WebSocket lifecycle management must be owned by the MCP
server, not Aegis, to maintain the MCP purity constraint. The pool
pattern ensures connections are reused and properly cleaned up.

feat(aegis): add autonomous task orchestration

Implement the core orchestrator loop (receive task, plan, execute,
evaluate, report). Add the planner that decomposes tasks into MCP
tool invocation sequences. Add the executor that runs steps with
timeout enforcement and error recovery. Add the reporter that streams
progress updates through the IPC bus.

Reasoning: The orchestrator treats all tools as MCP invocations,
whether they come from the Pterodactyl MCP server, the filesystem
MCP server, or dynamic skill tools. This uniformity means that adding
a new MCP server (e.g., for web search) requires zero changes to the
orchestration layer.

feat(skills): add dynamic skill engine

Implement skillEngine.ts for skill file discovery and hot-reload.
Add skillRunner.ts for executing Python, Node.js, and Bash skills
inside the sandbox with resource limits. Add skillManifest.ts for
generating MCP-compatible tool definitions from skill YAML frontmatter.

Reasoning: Dynamic skill synthesis is a key differentiator of the
Aegis architecture. By treating skills as MCP tools, the orchestrator
can invoke them using the same interface as Pterodactyl operations,
maintaining consistency and eliminating special-case code paths.

feat(deployment): add maintenance pipeline

Implement the full deployment lifecycle: playerMonitor.ts (zero-player
detection via get_player_count MCP tool), deploymentRunner.ts (backup,
file swap, restart, TPS validation, changelog), and rollback logic.
All Pterodactyl operations use MCP tools exclusively.

Reasoning: The deployment pipeline is the most Pterodactyl-intensive
component. By routing every operation through MCP tools (create_backup,
stop_server, start_server, restore_backup), we validate that the MCP
purity constraint works end-to-end for the most complex workflow in
the system.

test(mcp): add MCP integration suite

Add end-to-end tests for the MCP client ↔ Pterodactyl MCP server
communication. Test tool discovery, invocation, resource subscription,
circuit breaker behavior, and rate limit handling. Add mock transport
for unit testing without a live Pterodactyl panel.

Reasoning: The MCP integration suite is critical because it tests
the boundary between Aegis and the Pterodactyl MCP server — the
exact boundary where the MCP purity constraint is enforced. These
tests verify that Aegis can perform all required operations without
any direct Pterodactyl REST access.

docs: finalize architecture

Update all blueprint documents to reflect implementation decisions
made during development. Add 09_development_workflow.md and
10_architecture_consistency_audit.md. Verify all documents are
mutually consistent and contain zero architectural contradictions.
```

---

## C. Patch Export Process

### C.1 Why Patches Are Exported

The patch export process produces a portable, self-contained representation of the entire project history as a series of Git patch files. This serves several critical purposes:

1. **Offline deployment**: The production server running EdenVanguard may not have direct access to the Git repository (due to network policies or air-gapped environments). The patch series can be transferred via USB, SCP, or any out-of-band mechanism and applied to a bare Git repository on the target machine.

2. **Audit trail**: Each patch file is a human-readable diff with full commit metadata (author, date, message). This provides a tamper-evident record of every change that was applied to the production system, satisfying compliance and forensic requirements.

3. **Reproducible builds**: Given a specific patch series and a known base commit, any developer can reconstruct the exact state of the codebase at any point in history. This is essential for reproducing bugs that occurred in production.

4. **Rollback granularity**: Unlike a monolithic deployment artifact, a patch series allows surgical rollback to any intermediate commit. If a specific commit introduced a regression, that single patch can be reverted without losing subsequent unrelated changes.

5. **Version documentation**: The patch series, together with the commit log, serves as the definitive changelog for each release. This is more reliable than manually maintained changelogs, which tend to drift from reality.

### C.2 Generating the Patch Series

```bash
# 1. Verify clean working state
git status
# Must show: nothing to commit, working tree clean

# 2. Run the full test suite
npm run test:all
# Must pass with zero failures

# 3. Create a release tag
git tag -a v1.0.0 -m "EdenVanguard v1.0.0 — Initial production release"

# 4. Generate the complete patch series from the first commit to HEAD
mkdir -p patches
git format-patch --root HEAD -o patches/

# 5. Verify the patch series
ls -la patches/
# Should show numbered .patch files: 0001-..., 0002-..., etc.

# 6. Count patches and verify completeness
echo "Total patches: $(ls patches/*.patch | wc -l)"
echo "Last patch: $(ls patches/*.patch | tail -1)"
```

### C.3 How to Replay Patches

On a target machine:

```bash
# 1. Initialize a new repository
mkdir edenvanguard-replay && cd edenvanguard-replay
git init

# 2. Apply all patches in order
git am patches/*.patch

# 3. Verify the final state matches the release tag
git log --oneline | head -5
git tag -l

# 4. Verify the build
npm install
npm run build
npm run test:all
```

If a patch fails to apply cleanly (due to context changes):

```bash
# git am will pause and report the conflict
# Resolve the conflict manually:
git mergetool  # or edit the conflicting files

# Then continue:
git am --continue

# To abort and start over:
git am --abort
```

### C.4 Rollback Procedures

**Rolling back a single commit (revert):**

```bash
# Find the commit hash from the patch file or git log
git log --oneline | grep "the offending commit message"

# Create a revert commit
git revert <commit-hash>
# This creates a new commit that undoes the changes from the specified commit

# Push the revert to develop for review
git push origin HEAD:develop
```

**Rolling back to a specific release tag:**

```bash
# Find the target tag
git tag -l

# Create a branch from the known-good tag
git checkout -b hotfix/rollback-to-v1.0.0 v1.0.0

# Verify the system works at this version
npm run test:all

# Merge the rollback branch to main
git checkout main
git merge hotfix/rollback-to-v1.0.0
```

**Rolling back a specific patch from the series:**

```bash
# This is more manual but provides fine-grained control
# First, identify the patch file
ls patches/ | grep "keyword"

# Examine the patch
cat patches/0042-feat-deployment-add-maintenance-pipeline.patch

# Create a reverse patch
git apply -R patches/0042-feat-deployment-add-maintenance-pipeline.patch

# If it applies cleanly, commit the reversal
git commit -m "revert: deployment maintenance pipeline (patch 0042)"
```

### C.5 Release Workflow

1. **Pre-release validation**:
   - All tests pass on `develop`
   - No open security vulnerabilities (`npm audit`)
   - Architecture consistency audit (`10_architecture_consistency_audit.md`) shows no contradictions
   - All `ptero_credentials` entries are verified active (no orphaned inactive keys without replacements)

2. **Create release branch**:
   ```bash
   git checkout -b release/v1.0.0 develop
   ```

3. **Bump version** in all `package.json` files and update `docs/` if needed.

4. **Final validation**:
   ```bash
   npm run test:all
   npm run lint
   npm run typecheck
   ```

5. **Merge to `main`**:
   ```bash
   git checkout main
   git merge --no-ff release/v1.0.0
   git tag -a v1.0.0 -m "EdenVanguard v1.0.0"
   ```

6. **Generate patch series**:
   ```bash
   mkdir -p patches/v1.0.0
   git format-patch --root HEAD -o patches/v1.0.0/
   ```

7. **Create release artifact bundle**:
   ```bash
   mkdir -p release/v1.0.0
   cp -r patches/v1.0.0/ release/v1.0.0/patches/
   cp docs/ release/v1.0.0/docs/ -r
   git log --oneline --graph > release/v1.0.0/commit-log.txt
   git log --format="%H %s" > release/v1.0.0/commit-hashes.txt
   echo "v1.0.0" > release/v1.0.0/version.txt
   tar czf edenvanguard-v1.0.0.tar.gz release/v1.0.0/
   ```

8. **Back-merge to `develop`**:
   ```bash
   git checkout develop
   git merge main
   git branch -d release/v1.0.0
   ```

---

## D. Backup & Recovery

### D.1 Database Backup Process

The PostgreSQL database contains all operational state for the system. Regular backups are essential for disaster recovery.

**Automated daily backup (via cron):**

```bash
#!/bin/bash
# infra/scripts/backup_db.sh
# Run daily at 03:00 UTC via system cron

BACKUP_DIR="/opt/backups/postgres"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DB_HOST="postgres"
DB_NAME="edenvanguard"
DB_USER="postgres"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Full pg_dump with custom format (compressed, parallelizable)
pg_dump -h "$DB_HOST" -U "$DB_USER" -Fc --no-owner "$DB_NAME" \
    > "$BACKUP_DIR/edenvanguard_${TIMESTAMP}.dump"

# Verify the backup
if pg_restore --list "$BACKUP_DIR/edenvanguard_${TIMESTAMP}.dump" > /dev/null 2>&1; then
    echo "[$(date)] Backup verified: edenvanguard_${TIMESTAMP}.dump"
else
    echo "[$(date)] ERROR: Backup verification failed for edenvanguard_${TIMESTAMP}.dump"
    exit 1
fi

# Retain only the last 30 days of backups
find "$BACKUP_DIR" -name "edenvanguard_*.dump" -mtime +30 -delete

# Also create a SQL plain-text backup (human-readable, version-control friendly)
pg_dump -h "$DB_HOST" -U "$DB_USER" --no-owner "$DB_NAME" \
    > "$BACKUP_DIR/edenvanguard_${TIMESTAMP}.sql"

# Compress the SQL backup
gzip "$BACKUP_DIR/edenvanguard_${TIMESTAMP}.sql"
```

**Recovery from database backup:**

```bash
# 1. Stop all services
docker-compose down

# 2. Restore from custom-format backup
pg_restore -h postgres -U postgres -c -d edenvanguard \
    /opt/backups/postgres/edenvanguard_20250115_030000.dump

# OR restore from plain-text backup
gunzip /opt/backups/postgres/edenvanguard_20250115_030000.sql.gz
psql -h postgres -U postgres -d edenvanguard \
    < /opt/backups/postgres/edenvanguard_20250115_030000.sql

# 3. Verify key tables
psql -h postgres -U postgres -d edenvanguard -c "SELECT COUNT(*) FROM ptero_credentials WHERE is_active = true;"
psql -h postgres -U postgres -d edenvanguard -c "SELECT COUNT(*) FROM api_keys WHERE is_active = true;"

# 4. Restart services
docker-compose up -d
```

### D.2 Patch Backup Process

Patch files are the authoritative record of code evolution. They must be backed up alongside the database.

```bash
# After generating a patch series (Section C.2), copy to a secondary location
cp -r patches/ /opt/backups/patches/

# For release patches, also store in the release artifact bundle
cp -r patches/v1.0.0/ /opt/backups/releases/v1.0.0/patches/

# Verify patch integrity
cd edenvanguard-replay
git init
git am /opt/backups/patches/v1.0.0/*.patch
npm run test:all
# If tests pass, the patches are valid
```

### D.3 Deployment Rollback Process

When a deployed mod update causes server issues, the rollback procedure is:

1. **Automatic rollback** (preferred): Aegis detects the failure during TPS validation or health check and automatically invokes `Aegis.mcp.invoke("restore_backup", ...)` to restore from the pre-deployment backup. This is documented in `03_state_machines.md`, Section C (FAILED → ROLLBACK transition).

2. **Manual rollback via Aegis**: If automatic rollback fails, an admin can trigger it via Discord:
   ```
   @Vanguard rollback job <job_id>
   ```
   Vanguard dispatches the rollback command to Aegis, which invokes the MCP tools to stop the server, restore the backup, and restart.

3. **Manual rollback via Pterodactyl Panel** (last resort): If Aegis and the MCP server are both unresponsive, the admin accesses the Pterodactyl panel directly (as documented in `08_risks_and_limits.md`, Section 9.2).

4. **Code-level rollback**: If the issue is in the EdenVanguard code itself (not a deployed mod), revert to the previous release tag:
   ```bash
   git checkout v1.0.0
   npm run build
   docker-compose up -d --build
   ```

### D.4 Pterodactyl Rollback Process

Pterodactyl-level rollback refers to restoring the Minecraft server to a pre-deployment state using the Pterodactyl backup system. Every deployment creates a backup before making any changes, and the backup UUID is stored in `maintenance_queue.backup_uuid`.

**Standard Pterodactyl rollback** (performed by Aegis via MCP tools):

```
1. Aegis.mcp.invoke("get_server_resources", {server_id}) → check current_state
2. IF current_state !== "offline":
     Aegis.mcp.invoke("stop_server", {server_id})
     WAIT for offline state (poll up to 60 seconds)
3. Aegis.mcp.invoke("restore_backup", {server_id, backup_uuid, confirm: true})
4. Aegis.mcp.invoke("start_server", {server_id})
5. WAIT for boot completion (monitor console resource for "Done" message)
6. Aegis.mcp.invoke("send_command", {server_id, command: "tps"})
7. Aegis.mcp.invoke("get_server_resources", {server_id}) → verify health
```

**Emergency Pterodactyl rollback** (when MCP server is unavailable):

As documented in `08_risks_and_limits.md`, Section 9.2: access the Pterodactyl panel directly, navigate to the server's backup page, find the backup named `pre-deploy-{job_id}`, and click Restore.

**Post-rollback verification checklist:**

- [ ] Server is in `running` state
- [ ] TPS is at or above 19.0 (three consecutive readings)
- [ ] Memory usage is below 90% of allocated limit
- [ ] Console output shows "Done" message without crash indicators
- [ ] Player count matches expected value (0 during maintenance)
- [ ] `maintenance_queue` status is `rolled_back`
- [ ] Admin channel has been notified of the rollback
- [ ] `deployment_audit` records the rollback step with timestamp
