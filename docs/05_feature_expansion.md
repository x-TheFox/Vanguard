# 05 — Feature Expansion Proposals

The following three high-leverage features extend the EdenVanguard autonomous sysadmin paradigm. Each proposal includes a rationale, detailed specification, integration points with the existing architecture, and an assessment of implementation complexity.

---

## Feature 1: Predictive Server Health & Proactive Remediation Engine

### Rationale

The current system is fundamentally reactive — it responds to crashes after they happen and deploys mods only when admins trigger the pipeline. A Minecraft modded server, however, exhibits a rich set of leading indicators before catastrophic failure: gradual memory leaks manifest as rising heap utilization over hours, tick-time degradation precedes visible lag spikes, and specific mod interactions produce warning-level log entries that cascade into crashes under load. A predictive health engine would allow Aegis to detect these patterns early and take autonomous corrective action — restarting the server during a low-activity window *before* a crash displaces players, adjusting JVM heap parameters when memory pressure trends upward, or disabling a problematic mod temporarily until a fix is staged.

This feature shifts Aegis from a diagnostic responder to a **proactive guardian**, dramatically improving server uptime and player experience. It leverages the existing Pterodactyl console stream and resource monitoring infrastructure, requiring no new external integrations.

### Specification

**Data Collection Layer:**

A new time-series data store captures server telemetry at regular intervals (every 60 seconds). The metrics include:

- **TPS** — Sampled via the console `tps` command or Spark-like mod output
- **Memory utilization** — From Pterodactyl resource WebSocket events (heap_used / heap_max)
- **Player count** — Current concurrent players
- **Tick time** — Average milliseconds per tick (from Spark or `/spark tps`)
- **GC pause frequency** — Detected from console log patterns ("GC pause", "Full GC")
- **Error rate** — Count of WARN/ERROR log lines per interval

These metrics are stored in a new PostgreSQL table `server_telemetry` with a hypertable partition (via TimescaleDB extension) for efficient time-range queries:

```sql
CREATE TABLE server_telemetry (
    sample_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sampled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tps             NUMERIC(5,2),
    memory_used_mb  NUMERIC(10,2),
    memory_max_mb   NUMERIC(10,2),
    player_count    INTEGER,
    tick_time_ms    NUMERIC(8,3),
    gc_pause_count  INTEGER DEFAULT 0,
    error_count     INTEGER DEFAULT 0,
    server_id       TEXT NOT NULL
);

-- TimescaleDB hypertable (if available) or standard BRIN index
CREATE INDEX idx_telemetry_sampled_at ON server_telemetry (sampled_at DESC);
CREATE INDEX idx_telemetry_server_time ON server_telemetry (server_id, sampled_at DESC);
```

**Anomaly Detection Engine:**

Aegis runs a periodic analysis job (every 5 minutes) that evaluates recent telemetry against baseline thresholds. The analysis uses two complementary approaches:

1. **Static Threshold Rules** — Simple, deterministic rules with tuned constants:
   - TPS below 15.0 for 3 consecutive samples → Warning
   - TPS below 10.0 for 2 consecutive samples → Critical
   - Memory utilization above 90% for 5 consecutive samples → Warning
   - GC pause count above 10 per minute → Warning
   - Error count above 20 per minute → Warning

2. **Statistical Trend Analysis** — Detect gradual degradation that stays within static thresholds but trends toward failure:
   - Linear regression on TPS over the last 60 samples; if slope < -0.05 TPS/sample → Degradation Warning
   - Linear regression on memory utilization over last 120 samples; if slope > +0.2%/sample and current utilization > 70% → Memory Leak Warning
   - Exponential moving average (EMA) of tick time; if EMA exceeds 2x the 24-hour baseline → Tick Degradation Warning

The anomaly engine classifies findings into three severity tiers:

| Severity | Description | Response |
|---|---|---|
| **Advisory** | Trend detected, no immediate risk | Log internally; post subtle notification in admin channel |
| **Warning** | Threshold breached, degradation ongoing | Post public advisory in server Discord; recommend admin action; schedule preemptive restart for next zero-player window |
| **Critical** | Imminent failure likely | Immediate admin alert; Aegis may autonomously trigger a graceful restart (configurable per-server policy) |

**Proactive Remediation Actions:**

When the anomaly engine triggers a Warning or Critical alert, Aegis can execute remediation scripts:

- **Preemptive Restart** — Schedule a maintenance job (reusing the existing `maintenance_queue` infrastructure) to gracefully restart the server during the next zero-player window, even if no mod changes are pending. This clears memory leaks and resets GC pressure.
- **JVM Parameter Adjustment** — If memory pressure is the root cause and the server has headroom, Aegis can modify the startup flags (e.g., increase `-Xmx`) and schedule a restart with the new configuration. The old configuration is preserved as a backup.
- **Problematic Mod Quarantine** — If a specific mod is correlated with the degradation (identified via log analysis or Spark profiler output), Aegis can propose temporarily disabling the mod by moving its JAR to a `disabled_mods/` directory, scheduling the change for the next low-activity window.
- **Config Tweak Proposals** — For tick-time degradation, Aegis can suggest or apply configuration changes (e.g., reducing entity processing range, disabling specific world-gen features) based on its analysis of the server's mod ecosystem.

**Integration Points:**

- Reuses `aegis/src/cron/` for the 60-second telemetry collection and 5-minute analysis jobs
- Reuses MCP Pterodactyl tools (invoked via `Aegis.mcp.invoke()`) for all server interactions
- Reuses `maintenance_queue` for scheduling preemptive restarts
- Posts alerts through Vanguard's existing Discord embed system
- Admins can configure remediation policies (automatic vs. advisory-only) via a new slash command: `/aegis health-policy`

**Implementation Complexity:** Medium-High. The telemetry collection is straightforward, but the statistical analysis engine requires careful tuning of thresholds and regression parameters to avoid false positives. Estimated 2-3 weeks of focused development.

---

## Feature 2: Community Knowledge Base & Self-Service Resolution Portal

### Rationale

A significant portion of crash reports and mod suggestions represent recurring patterns — the same mod conflicts, the same configuration mistakes, the same version incompatibilities. Currently, each crash diagnostic thread is an isolated event; Aegis diagnoses it from scratch every time, consuming LLM inference tokens, web search queries, and sandbox computation. This is wasteful and slow for known issues.

A community knowledge base would allow Aegis to cache resolved diagnostic patterns, creating a growing corpus of institutional memory. When a new crash report arrives, Aegis first queries the knowledge base for matching signatures before invoking expensive external analysis. For users, this means near-instant resolution for known problems. For operators, it means dramatically reduced inference costs and faster mean-time-to-resolution.

Furthermore, this knowledge base can power a self-service portal: players can search for their error message or mod name directly in a Discord channel using a slash command like `/aegis lookup <error>` before posting a full diagnostic thread. This reduces the volume of diagnostic threads Aegis needs to process and empowers the community to help themselves.

### Specification

**Knowledge Base Data Model:**

```sql
CREATE TABLE knowledge_entries (
    entry_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Classification
    category        TEXT NOT NULL CHECK (category IN ('crash_pattern', 'mod_conflict', 'config_fix', 'performance_tweak', 'general_tip')),
    
    -- Pattern matching
    error_signature TEXT NOT NULL,              -- Canonical error class (e.g., "NoClassDefFoundError: net/minecraft/class_1234")
    keywords        TEXT[] NOT NULL,             -- Searchable keywords: ["create", "flywheel", "version mismatch"]
    mod_identifiers JSONB DEFAULT '[]',         -- Associated mods [{curseforge_id, modrinth_id, slug, name}]
    mc_version_range TEXT,                       -- ">=1.20.0 <1.21.0"
    mod_loader      TEXT,                        -- "forge" | "fabric" | "neoforge" | null (any)
    
    -- Content
    title           TEXT NOT NULL,               -- "Create + Flywheel Version Mismatch Crash"
    root_cause      TEXT NOT NULL,               -- Detailed root cause explanation
    resolution      TEXT NOT NULL,               -- Step-by-step resolution instructions
    references      JSONB DEFAULT '[]',          -- URLs to GitHub issues, forum posts, etc.
    
    -- Metadata
    source_thread_id TEXT,                       -- Original Discord thread where this was diagnosed
    confidence       NUMERIC(3,2) DEFAULT 1.0,   -- 1.0 = confirmed by Aegis; lower = unverified
    upvote_count     INTEGER DEFAULT 0,          -- Community validation
    downvote_count   INTEGER DEFAULT 0,
    view_count       INTEGER DEFAULT 0,
    
    is_active        BOOLEAN DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Full-text search index
CREATE INDEX idx_knowledge_fts ON knowledge_entries 
    USING GIN (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(root_cause, '') || ' ' || coalesce(resolution, '')));

-- Error signature lookup
CREATE INDEX idx_knowledge_signature ON knowledge_entries (error_signature);

-- Keyword array index
CREATE INDEX idx_knowledge_keywords ON knowledge_entries USING GIN (keywords);
```

**Knowledge Acquisition Pipeline:**

When Aegis successfully resolves a crash diagnostic thread, it automatically generates a knowledge entry:

1. Aegis extracts the canonical error signature from the parsed crash log (normalized class name, stripped of line numbers and instance-specific data).
2. Aegis composes a structured knowledge entry using the resolution summary, root cause analysis, and references gathered during diagnosis.
3. The entry is inserted with `confidence = 0.8` (auto-generated, pending verification).
4. If the same error signature is resolved again with the same root cause, confidence is incremented toward 1.0.
5. If a resolution is contradicted (user reports it didn't work), confidence is decremented.

Admins can also manually create or edit knowledge entries via a slash command: `/aegis knowledge add`

**Self-Service Lookup Flow:**

1. User types `/aegis lookup Out of memory java heap space` in any permitted channel.
2. Vanguard parses the query and dispatches to Aegis.
3. Aegis performs a ranked search against the knowledge base:
   - First: exact error signature match (fastest, most reliable)
   - Second: full-text search on keywords and title
   - Third: semantic similarity via LLM embedding (if available; future enhancement)
4. If a match is found with `confidence >= 0.7`, Aegis returns the resolution directly in the channel as an embed, with a "Was this helpful?" reaction for community feedback.
5. If no match is found, Aegis suggests creating a diagnostic thread for full analysis.

**Discord Channel: `#aegis-kb-search`**

A dedicated channel where players can type natural language queries (not just slash commands). Aegis monitors this channel and responds with knowledge base matches. Low-noise, high-value channel that reduces the burden on both admins and the diagnostic thread system.

**Integration Points:**

- Reuses the crash diagnostic lifecycle (03_state_machines.md, Section A) as the primary knowledge acquisition source
- Reuses `aegis/src/inference/` for composing knowledge entries
- Adds a new Vanguard gateway listener for the `#aegis-kb-search` channel
- Knowledge base queries are local PostgreSQL lookups — zero LLM inference cost for known issues

**Implementation Complexity:** Medium. The data model and search logic are straightforward. The primary effort is in the knowledge acquisition pipeline (auto-generating high-quality entries from resolved threads) and the search ranking algorithm. Estimated 1.5-2 weeks of focused development.

---

## Feature 3: Multi-Server Fleet Orchestration & Configuration Drift Detection

### Rationale

As the platform grows, operators may manage multiple Minecraft servers — a primary survival server, a creative testing server, an event server, and potentially modpack-specific instances. Currently, EdenVanguard is designed around a single-server paradigm. Extending to fleet-level orchestration introduces powerful new capabilities: synchronized mod updates across servers, configuration drift detection and correction, cross-server player migration during maintenance, and unified health monitoring dashboards.

Even for a single-server deployment, configuration drift detection is valuable. Over time, manual edits by admins, failed deployments, or mod self-modification can cause the server's actual configuration to diverge from the intended state tracked in the `maintenance_queue` and `suggestion_threads` tables. Aegis currently assumes that after a successful deployment, the server state matches expectations. Configuration drift detection would periodically verify this assumption and flag or correct deviations.

This feature transforms Aegis from a single-server administrator to a **fleet-aware orchestrator**, capable of maintaining consistency across an entire infrastructure.

### Specification

**Fleet Data Model:**

```sql
CREATE TABLE fleet_servers (
    server_id           TEXT PRIMARY KEY,           -- Pterodactyl server UUID
    server_name         TEXT NOT NULL,              -- "Survival Main", "Creative Test"
    server_type         TEXT NOT NULL,              -- "production" | "staging" | "development"
    pterodactyl_node    TEXT NOT NULL,              -- Node identifier
    minecraft_version   TEXT,
    mod_loader          TEXT,                       -- "forge" | "fabric" | "neoforge"
    modpack_slug        TEXT,                       -- Reference modpack identifier
    
    -- Fleet grouping
    fleet_group         TEXT NOT NULL DEFAULT 'default',  -- Group servers for coordinated operations
    
    -- Desired state tracking
    desired_config_hash TEXT,                       -- SHA-256 of expected file tree
    last_drift_check_at TIMESTAMPTZ,
    drift_status        TEXT DEFAULT 'nominal',     -- "nominal" | "drift_detected" | "correcting"
    
    is_active           BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fleet_deployment_groups (
    group_id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                TEXT NOT NULL UNIQUE,
    description         TEXT,
    server_ids          TEXT[] NOT NULL,            -- Array of fleet_servers.server_id
    deployment_strategy TEXT NOT NULL DEFAULT 'sequential',
        -- "sequential": deploy to one server at a time, validate, then proceed
        -- "parallel": deploy to all servers simultaneously
        -- "rolling": deploy to N servers at a time (canary deployment)
    
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE configuration_snapshots (
    snapshot_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    server_id           TEXT NOT NULL REFERENCES fleet_servers(server_id),
    snapshot_type       TEXT NOT NULL CHECK (snapshot_type IN ('automatic', 'pre_deployment', 'manual')),
    file_tree_hash      TEXT NOT NULL,              -- SHA-256 of entire file tree
    file_tree           JSONB NOT NULL,             -- [{path, hash, size, modified_at}]
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_config_snapshots_server ON configuration_snapshots (server_id, created_at DESC);
```

**Configuration Drift Detection:**

Aegis periodically (every 6 hours, configurable) computes a snapshot of each server's file tree and compares it against the last known-good snapshot:

1. **Snapshot Computation:**
   - Aegis uses the Pterodactyl file manager API to recursively list all files in key directories (`/mods/`, `/config/`, `/defaultconfigs/`, `/kubejs/`, `/server.properties`, etc.)
   - For each file, it computes a hash (via `head -c` + `sha256sum` for small files, or size+mtime heuristic for large files to minimize API calls)
   - The snapshot is stored in `configuration_snapshots`

2. **Drift Comparison:**
   - Aegis compares the current snapshot against the baseline (last `pre_deployment` or `automatic` snapshot that was verified as correct)
   - Differences are classified:
     - **Added files** — Files present now but not in baseline (e.g., a mod was manually added)
     - **Removed files** — Files in baseline but not now (e.g., a mod was manually deleted)
     - **Modified files** — Same path, different hash (e.g., a config was edited)
   - A drift score is computed: `(added + removed + modified) / total_baseline_files`

3. **Drift Response:**
   - **Low drift (<2%)** — Log internally; no action
   - **Medium drift (2-10%)** — Post a warning in admin channel with a detailed diff summary
   - **High drift (>10%)** — Post a critical alert; offer auto-correction (restore baseline state)
   - Admins can approve auto-correction via a button interaction, which creates a maintenance job to restore the drifted files

**Fleet Deployment Coordination:**

When a mod update or configuration change needs to be applied to multiple servers:

1. Admin creates a fleet deployment via `/aegis fleet-deploy create`:
   - Selects a `fleet_deployment_group` (e.g., "All Production Servers")
   - Specifies the target files and configurations
   - Chooses a deployment strategy (sequential, parallel, rolling)

2. Aegis creates individual `maintenance_queue` jobs for each server in the group, linked by a common `fleet_deployment_group_id`.

3. **Sequential Strategy:**
   - Deploy to server 1 → validate (TPS check) → if successful, proceed to server 2 → and so on
   - If any server fails, halt the fleet deployment and alert admins

4. **Rolling Strategy:**
   - Deploy to N servers simultaneously (N = group size / 3, rounded up)
   - Validate each batch before proceeding to the next
   - If any server in a batch fails, halt and alert

5. **Cross-Server Player Migration:**
   - Before stopping a server for maintenance, Aegis can announce in the server's Discord channel: "Server XYZ is going down for maintenance in 5 minutes. Join Server ABC to continue playing!"
   - Aegis can optionally execute a console command to broadcast the migration message in-game

**Unified Health Dashboard:**

Aegis generates a periodic (hourly) fleet health summary posted to a designated admin channel:

```
📊 Fleet Health Report — 2025-01-15 14:00 UTC

🟢 Survival Main   | TPS: 20.0 | Players: 12 | Memory: 67% | Drift: 0.3%
🟢 Creative Test   | TPS: 20.0 | Players: 3  | Memory: 42% | Drift: Nominal
🟡 Event Server    | TPS: 17.2 | Players: 24 | Memory: 89% | Drift: 2.1% (1 config modified)
🔴 Staging Dev     | OFFLINE   | Last seen: 2h ago

⚠️ Alerts:
  - Event Server: Memory utilization trending upward (+8% over 2h)
  - Staging Dev: Server unreachable, last known state was starting
```

**Integration Points:**

- Extends MCP Pterodactyl tool invocations with multi-server awareness (each tool already accepts a `server_id` parameter; this adds iteration logic across multiple servers)
- Extends `aegis/src/cron/` with the drift detection scheduler
- Adds new `fleet_servers` and `fleet_deployment_groups` tables to the database
- Extends `maintenance_queue` with a `fleet_group_id` field to link coordinated deployments
- Vanguard adds new slash commands for fleet management
- Reuses the existing deployment lifecycle (03_state_machines.md, Section C) for each individual server in the fleet

**Implementation Complexity:** High. This is the most ambitious expansion feature, requiring significant new infrastructure for fleet coordination, drift detection algorithms, and multi-server deployment orchestration. However, the modular design of the existing architecture means much of the logic can be composed from existing components. Estimated 3-4 weeks of focused development, with drift detection being the lowest-hanging fruit that can be shipped independently.
