# 03 — State Machine Execution Lifecycles

This document maps the sequential pseudocode pathways for the three core event lifecycles in EdenVanguard. Each lifecycle is presented as a state machine with clearly defined transitions, error recovery paths, and database state mutations.

---

## A. Crash Log Troubleshooting Lifecycle

### Overview

When a player pastes a Minecraft crash report or link in any monitored channel, Vanguard detects the signature, creates a diagnostic thread, and delegates to Aegis for autonomous root-cause analysis. Aegis may invoke web searches, sandbox shell commands, and MCP tools to diagnose and resolve the issue.

### State Diagram

```
[IDLE] ──crash detected──▶ [THREAD_CREATED] ──task dispatched──▶ [DIAGNOSING]
       ◀──resolved────────       │                                    │
       │                         │                          ┌────────┴────────┐
       │                         │                    [SEARCHING]       [PARSING_LOG]
       │                         │                          │                │
       │                         │                    [ANALYZING]◀───────────┘
       │                         │                          │
       │                         │                   ┌──────┴──────┐
       │                         │              [ROOT_CAUSE]  [NEED_MORE_INFO]
       │                         │                   │              │
       │                         │                   │         [INTERACTING]
       │                         │                   │              │
       │                         │                   ▼              ▼
       │                         │            [RESOLVED] ◀───[CONFIRMED]
       │                         │                   │
       ◀──thread closed──────────┴───────────────────┘
```

### Pseudocode

```
STATE MACHINE: CrashLogTroubleshooter
──────────────────────────────────────

INITIAL_STATE: IDLE

─── TRANSITION: IDLE → THREAD_CREATED ───────────────────────
TRIGGER: Vanguard.messageRouter detects crash signature in message M
GUARD:   M.channel is in permitted_channels AND M.author is not a bot
ACTION:
    1. Vanguard.crashDetector.extractCrashContent(M)
       - IF M contains raw crash text:
           raw_log = M.content (extracted between regex delimiters)
       - IF M contains paste link (mclogs, pastebin, gnome.dev):
           raw_log = Vanguard.pasteLinkExtractor.resolve(link_url)
           - IF resolution fails:
               Vanguard.post(M.channel, "I detected a paste link but couldn't fetch it. Please paste the log directly.")
               RETURN to IDLE
    
    2. player_name = extractPlayerName(raw_log) OR M.author.username
       thread = Vanguard.threadManager.createThread(
           parent_message = M,
           name = f"Aegis Diagnostic - {player_name}",
           auto_archive_duration = 1440  // 24 hours
       )
    
    3. Vanguard.post(thread, embed: {
           title: "🔍 Crash Diagnostic Initiated",
           description: "Aegis is analyzing your crash report. This may take a moment...",
           color: BLUE
       })
    
    4. task_payload = {
           type: "crash_diagnosis",
           raw_log: raw_log,
           thread_id: thread.id,
           player_name: player_name,
           message_id: M.id,
           guild_id: M.guild.id
       }
    
    5. Vanguard.busPublisher.publish("vanguard.crash.new", task_payload)
    
    6. DB: INSERT INTO audit_log (table_name, record_id, action, changed_by, new_values)
       VALUES ('crash_events', thread.id, 'INSERT', 'vanguard', task_payload)
    
NEXT_STATE: THREAD_CREATED


─── TRANSITION: THREAD_CREATED → DIAGNOSING ──────────────────
TRIGGER: Aegis receives "vanguard.crash.new" message from NATS
ACTION:
    1. Aegis.orchestrator.receiveTask(payload)
    2. plan = Aegis.planner.decompose("crash_diagnosis", payload)
       // Plan steps:
       //   Step 1: Parse crash log structure
       //   Step 2: Identify root-cause exception class
       //   Step 3: Separate cascading warnings from primary error
       //   Step 4: Search for known fixes (web search, GitHub issues)
       //   Step 5: Formulate resolution or request more information
    
    3. Aegis.reporter.streamLog(thread_id, "⏳ Beginning crash log analysis...")
    
NEXT_STATE: DIAGNOSING


─── TRANSITION: DIAGNOSING → PARSING_LOG ─────────────────────
ACTION:
    1. parsed = Aegis.sandbox.shellExec(`
           python3 /opt/skills/crash-parser.py --input="${sanitized_log_path}"
       `)
       // crash-parser.py is a skill file that:
       //   - Extracts: Minecraft version, Forge/Fabric version, mod list
       //   - Identifies: Exception class, stack trace, causation chain
       //   - Classifies: Root-cause vs. cascading warnings
       //   - Output: structured JSON
    
    2. IF parsed.exit_code !== 0:
       Aegis.reporter.streamLog(thread_id, "⚠️ Automated parsing encountered issues, falling back to LLM analysis...")
       parsed = Aegis.inference.resilientClient.analyze(raw_log, system_prompt=CRASH_PARSER_PROMPT)
    
    3. root_cause = parsed.root_exception    // e.g., "java.lang.NoClassDefFoundError: net/minecraft/class_1234"
       mod_list = parsed.loaded_mods          // [{name, version, id}]
       mc_version = parsed.minecraft_version
       mod_loader = parsed.mod_loader         // "forge" | "fabric" | "neoforge"
    
    4. Aegis.reporter.streamLog(thread_id, f"📋 **Parsed:** Minecraft {mc_version} / {mod_loader}")
    5. Aegis.reporter.streamLog(thread_id, f"🔴 **Root Cause:** `{root_cause}`")
    
NEXT_STATE: PARSING_LOG → SEARCHING (parallel path continues)


─── TRANSITION: PARSING_LOG → SEARCHING ──────────────────────
ACTION:
    1. search_queries = Aegis.planner.generateSearchQueries(root_cause, mod_list)
       // Example queries:
       //   - "NoClassDefFoundError net.minecraft.class_1234 fabric 1.20.1 fix"
       //   - "{offending_mod_name} crash {mc_version} github issue"
       //   - "{offending_mod_name} {root_cause_simple} solution"
    
    2. FOR EACH query IN search_queries (max 3):
       results = Aegis.websearch.searchClient.search(query, num=5)
       relevant = Aegis.websearch.resultParser.filterRelevant(results, root_cause)
       IF relevant.length > 0:
           BREAK  // Found sufficient results
    
    3. IF no results found:
       // Try MCP web-search tool as fallback
       mcp_tool = Aegis.mcp.toolRegistry.find("web_search")
       IF mcp_tool:
           results = mcp_tool.invoke({query: search_queries[0]})
           relevant = Aegis.websearch.resultParser.filterRelevant(results, root_cause)
    
NEXT_STATE: SEARCHING → ANALYZING


─── TRANSITION: SEARCHING → ANALYZING ────────────────────────
ACTION:
    1. analysis = Aegis.inference.resilientClient.analyze(
           context = {
               root_cause,
               mod_list,
               search_results: relevant,
               mc_version,
               mod_loader
           },
           system_prompt = CRASH_RESOLUTION_PROMPT
       )
    
    2. resolution = analysis.resolution
       // resolution = {
       //   summary: "The crash is caused by a version mismatch between Create 0.5.1 and Flywheel 0.6.9...",
       //   confidence: 0.92,
       //   steps: ["Update Flywheel to 0.6.10 or later", "If using KubeJS, ensure compatibility with Create 0.5.1"],
       //   references: ["https://github.com/Creators-of-Create/Create/issues/1234"],
       //   needs_user_input: false
       // }
    
    3. IF resolution.confidence >= 0.7 AND NOT resolution.needs_user_input:
       → TRANSITION to ROOT_CAUSE (high confidence resolution)
    
    4. IF resolution.needs_user_input OR resolution.confidence < 0.5:
       → TRANSITION to NEED_MORE_INFO
    
    5. ELSE (0.5 <= confidence < 0.7):
       → TRANSITION to ROOT_CAUSE (with uncertainty flag)


─── TRANSITION: ANALYZING → ROOT_CAUSE ───────────────────────
ACTION:
    1. Vanguard.post(thread, embed: {
           title: "✅ Root Cause Identified",
           description: resolution.summary,
           fields: [
               { name: "Confidence", value: f"{resolution.confidence * 100}%", inline: true },
               { name: "Resolution Steps", value: resolution.steps.join("\n"), inline: false },
               { name: "References", value: resolution.references.join("\n"), inline: false }
           ],
           color: resolution.confidence >= 0.7 ? GREEN : YELLOW
       })
    
    2. IF resolution.confidence < 0.7:
       Vanguard.post(thread, "⚠️ This diagnosis has moderate confidence. Please verify before taking action.")
    
NEXT_STATE: ROOT_CAUSE → RESOLVED (if no user interaction needed)
            ROOT_CAUSE → INTERACTING (if user asks follow-up)


─── TRANSITION: ANALYZING → NEED_MORE_INFO ───────────────────
ACTION:
    1. Vanguard.post(thread, embed: {
           title: "❓ Additional Information Needed",
           description: "I couldn't determine the exact cause with high confidence. I have a few questions:",
           fields: resolution.follow_up_questions.map(q => ({ name: "Question", value: q }))
       })
    
NEXT_STATE: NEED_MORE_INFO → INTERACTING


─── STATE: INTERACTING ───────────────────────────────────────
DESCRIPTION: Aegis monitors the diagnostic thread for user responses.
             Each user message in the thread is forwarded to Aegis for contextual analysis.

ON_MESSAGE_IN_THREAD:
    1. Vanguard.gateway.messageRouter.onThreadMessage(thread_id, message)
    2. task_payload = { type: "crash_followup", thread_id, user_message: message.content, conversation_history }
    3. Vanguard.busPublisher.publish("vanguard.crash.followup", task_payload)
    4. Aegis processes with full conversation context:
       - Re-analyzes with new information
       - May invoke additional searches or sandbox commands
       - Posts updated diagnosis or asks further questions
    5. IF user confirms resolution:
       → TRANSITION to CONFIRMED
    6. IF conversation idle for 30 minutes:
       → TRANSITION to RESOLVED (with "unconfirmed" tag)


─── TRANSITION: INTERACTING → CONFIRMED ──────────────────────
ACTION:
    1. Vanguard.post(thread, "✅ Glad that resolved it! This thread will be archived shortly.")
    
NEXT_STATE: CONFIRMED → RESOLVED


─── TRANSITION: CONFIRMED/ROOT_CAUSE → RESOLVED ─────────────
ACTION:
    1. Vanguard.threadManager.archiveThread(thread_id)
    2. DB: UPDATE crash_events SET status = 'resolved', resolved_at = NOW() WHERE thread_id = thread_id
    3. Aegis.reporter.publishResult("aegis.result.crash", { thread_id, resolution_summary })

NEXT_STATE: IDLE


─── ERROR RECOVERY ───────────────────────────────────────────
ON_ANY_STEP_FAILURE:
    1. Aegis.reporter.streamLog(thread_id, f"⚠️ Error in step '{current_step}': {error.message}")
    2. IF retry_count < max_retries AND error IS recoverable:
       Aegis.reporter.streamLog(thread_id, "🔄 Retrying...")
       → RE-ENTER current state with retry_count++
    3. ELSE:
       Vanguard.post(thread, embed: {
           title: "❌ Diagnostic Failed",
           description: f"I encountered an unrecoverable error: {error.message}. An admin has been notified.",
           color: RED
       })
       Vanguard.threadManager.archiveThread(thread_id)
       → RETURN to IDLE

```

---

## B. Partial Overlap Forum Deduplication Lifecycle

### Overview

When a user posts a suggestion in the Discord Forum containing multiple mod names, Aegis must resolve each mod to a canonical identifier, check for duplicates against active server mods and existing suggestion threads, isolate duplicates, and evaluate only the unique entries.

### State Diagram

```
[FORUM_POST_CREATED] ──▶ [RESOLVING_MODS] ──▶ [CHECKING_OVERLAPS]
                              │                      │
                              │              ┌───────┴────────┐
                              │         [FULL_DUPLICATE]  [PARTIAL_OVERLAP]
                              │              │                │
                              │         [ARCHIVING]     [EXCLUDING_DUPES]
                              │              │                │
                              │         [CLOSED]         [EVALUATING_UNIQUE]
                              │                               │
                              │                        ┌──────┴──────┐
                              │                   [BYTECODE_SCAN]  [DEEP_ANALYSIS]
                              │                        │              │
                              │                        ▼              ▼
                              │                   [BUILDING_UI]
                              │                        │
                              │                   [AWAITING_ADMIN]
                              │                        │
                              │              ┌─────────┴─────────┐
                              │         [APPROVED]          [REJECTED]
                              │              │                    │
                              │         [STAGING]            [CLOSING]
                              │              │                    │
                              │         [QUEUED_FOR_DEPLOY]   [CLOSED]
                              │              │
                              │              ▼
                              │    (Transitions to Deployment Lifecycle)
```

### Pseudocode

```
STATE MACHINE: SuggestionDeduplicator
──────────────────────────────────────

INITIAL_STATE: FORUM_POST_CREATED

─── TRANSITION: FORUM_POST_CREATED → RESOLVING_MODS ─────────
TRIGGER: Vanguard.forumWatcher detects new thread in Suggestions Forum
GUARD:   Thread is in the configured suggestions_forum_id
ACTION:
    1. raw_text = forum_post.content
       author = forum_post.author
    
    2. Vanguard.post(thread, embed: {
           title: "📋 Suggestion Received",
           description: "Aegis is analyzing your mod suggestions...",
           color: BLUE
       })
    
    3. task_payload = {
           type: "suggestion_evaluation",
           raw_text: raw_text,
           thread_id: thread.id,
           author_id: author.id,
           guild_id: thread.guild.id
       }
    
    4. Vanguard.busPublisher.publish("vanguard.suggestion.new", task_payload)
    
    5. DB: INSERT INTO suggestion_threads (thread_id, original_post_id, guild_id, channel_id,
           author_discord_id, raw_suggestion_text, status)
       VALUES (thread.id, thread.id, guild_id, channel_id, author.id, raw_text, 'review')

NEXT_STATE: RESOLVING_MODS


─── TRANSITION: RESOLVING_MODS → CHECKING_OVERLAPS ──────────
ACTION:
    1. mod_names = Aegis.inference.resilientClient.extract(raw_text, MOD_EXTRACTION_PROMPT)
       // Returns: ["Alex's Mobs", "Create", "Already Added Mod"]
    
    2. resolved_mods = []
       FOR EACH name IN mod_names:
           // Try CurseForge first
           cf_result = Aegis.modResolver.searchCurseForge(name)
           // Try Modrinth as fallback
           mr_result = Aegis.modResolver.searchModrinth(name)
           
           unified = {
               curseforge_id: cf_result?.id,
               modrinth_id: mr_result?.id,
               slug: cf_result?.slug || mr_result?.slug,
               name: name,
               version: extractLatestCompatibleVersion(cf_result, mr_result),
               status: "pending",  // Will be set in overlap check
               duplicate_of_thread_id: null,
               bytecode_report: null
           }
           resolved_mods.append(unified)
    
    3. Aegis.reporter.streamLog(thread_id, f"📋 Resolved {resolved_mods.length} mods: {resolved_mods.map(m => m.name).join(', ')}")
    
    4. DB: UPDATE suggestion_threads SET mod_identifiers = resolved_mods WHERE thread_id = thread_id

NEXT_STATE: CHECKING_OVERLAPS


─── TRANSITION: CHECKING_OVERLAPS ────────────────────────────
ACTION:
    1. exclusion_list = []
    
    2. // Check each resolved mod against:
    //    (a) Active server mod list (from Pterodactyl file listing)
    //    (b) Existing suggestion threads in 'review' or 'staged' status
    
    active_server_mods = Aegis.mcp.invoke("list_files", {server_id: target_server_id, path: "/mods/"})
    active_suggestions = DB.query(
        "SELECT thread_id, mod_identifiers FROM suggestion_threads
         WHERE status IN ('review', 'staged') AND thread_id != $1",
        [thread_id]
    )
    
    3. FOR EACH mod IN resolved_mods:
       is_duplicate = FALSE
       
       // Check (a): Is the mod already on the server?
       IF active_server_mods.contains(mod.slug) OR active_server_mods.contains(mod.curseforge_id):
           mod.status = "duplicate"
           mod.duplicate_of_thread_id = null  // It's on the server, not in a thread
           exclusion_list.append({
               slug: mod.slug,
               reason: "Already active on server",
               reference_thread_id: null
           })
           is_duplicate = TRUE
       
       // Check (b): Is the mod in another active suggestion thread?
       IF NOT is_duplicate:
           FOR EACH suggestion IN active_suggestions:
               FOR EACH existing_mod IN suggestion.mod_identifiers:
                   IF existing_mod.curseforge_id == mod.curseforge_id
                      OR existing_mod.modrinth_id == mod.modrinth_id
                      OR existing_mod.slug == mod.slug:
                       mod.status = "duplicate"
                       mod.duplicate_of_thread_id = suggestion.thread_id
                       exclusion_list.append({
                           slug: mod.slug,
                           reason: "Already under review in another thread",
                           reference_thread_id: suggestion.thread_id
                       })
                       is_duplicate = TRUE
                       BREAK
               IF is_duplicate: BREAK
       
       IF NOT is_duplicate:
           mod.status = "unique"
    
    4. all_duplicates = resolved_mods.every(m => m.status === "duplicate")
       any_duplicates = resolved_mods.some(m => m.status === "duplicate")
       unique_mods = resolved_mods.filter(m => m.status === "unique")
    
    5. DB: UPDATE suggestion_threads
       SET mod_identifiers = resolved_mods,
           exclusion_list = exclusion_list
       WHERE thread_id = thread_id

NEXT_STATE:
    IF all_duplicates → FULL_DUPLICATE
    IF any_duplicates → PARTIAL_OVERLAP
    ELSE → EVALUATING_UNIQUE (skip dedup, all unique)


─── TRANSITION: FULL_DUPLICATE → ARCHIVING ───────────────────
ACTION:
    1. duplicate_report = ""
       FOR EACH mod IN resolved_mods:
           IF mod.duplicate_of_thread_id:
               duplicate_report += f"• **{mod.name}** — Already under review: <#{mod.duplicate_of_thread_id}>\n"
           ELSE:
               duplicate_report += f"• **{mod.name}** — Already active on the server\n"
    
    2. Vanguard.post(thread, embed: {
           title: "🔁 All Suggestions Are Duplicates",
           description: "Every mod in your suggestion already exists on the server or is under active review:\n\n" + duplicate_report,
           color: ORANGE
       })
    
    3. DB: UPDATE suggestion_threads SET status = 'archived' WHERE thread_id = thread_id
    4. Vanguard.threadManager.lockThread(thread_id)
    5. Vanguard.threadManager.archiveThread(thread_id)

NEXT_STATE: CLOSED → IDLE


─── TRANSITION: PARTIAL_OVERLAP → EXCLUDING_DUPES ────────────
ACTION:
    1. exclusion_summary = ""
       FOR EACH excluded IN exclusion_list:
           IF excluded.reference_thread_id:
               exclusion_summary += f"• **{excluded.slug}** — {excluded.reason} (see <#{excluded.reference_thread_id}>)\n"
           ELSE:
               exclusion_summary += f"• **{excluded.slug}** — {excluded.reason}\n"
    
    2. unique_summary = unique_mods.map(m => f"• **{m.name}** ({m.version})").join("\n")
    
    3. Vanguard.post(thread, embed: {
           title: "🔀 Partial Overlap Detected",
           description: "Some mods in your suggestion are duplicates and have been excluded:\n\n" +
                        "**Excluded:**\n" + exclusion_summary + "\n" +
                        "**Proceeding with unique entries:**\n" + unique_summary,
           color: YELLOW
       })

NEXT_STATE: EXCLUDING_DUPES → EVALUATING_UNIQUE


─── TRANSITION: EVALUATING_UNIQUE → BYTECODE_SCAN ────────────
ACTION:
    1. FOR EACH mod IN unique_mods:
       // Download the .jar into the sandbox
       jar_path = Aegis.jarDownloader.download(
           mod.curseforge_id || mod.modrinth_id,
           mod.version,
           destination = "/workspace/downloads/"
       )
       
       Aegis.reporter.streamLog(thread_id, f"⬇️ Downloaded {mod.name} for analysis...")
    
    2. // Run bytecode profiling skill in sandbox
       FOR EACH mod IN unique_mods:
       jar_path = `/workspace/downloads/${mod.slug}-${mod.version}.jar`
       
       // Check for Mixin annotations
       mixin_report = Aegis.sandbox.shellExec(`
           python3 /opt/skills/jar-mixin-scanner.py --jar="${jar_path}" --format=json
       `)
       
       // Check structural dependencies
       dep_report = Aegis.sandbox.shellExec(`
           java -jar /opt/skills/dependency-analyzer.jar "${jar_path}" --output=json
       `)
       
       // Estimate resource overhead
       resource_report = Aegis.sandbox.shellExec(`
           python3 /opt/skills/resource-estimator.py --jar="${jar_path}" --format=json
       `)
       
       // If any skill script doesn't exist, Aegis dynamically writes it:
       IF NOT file_exists("/opt/skills/jar-mixin-scanner.py"):
           Aegis.inference.resilientClient.generate(
               prompt = "Write a Python script that scans a .jar file for Mixin annotations...",
               output_path = "/opt/skills/jar-mixin-scanner.py"
           )
           Aegis.skillEngine.register("/opt/skills/jar-mixin-scanner.py")
       
       mod.bytecode_report = {
           mixins: mixin_report.parsed,
           dependencies: dep_report.parsed,
           resources: resource_report.parsed,
           collision_risks: assessCollisions(mixin_report, unique_mods)
       }
       
       Aegis.reporter.streamLog(thread_id, f"🔬 Analyzed {mod.name}: {summarize(mod.bytecode_report)}")
    
    3. DB: UPDATE suggestion_threads
       SET bytecode_analysis = (compiled analysis),
           dependency_graph = (dependency tree),
           resource_estimate = (resource estimates)
       WHERE thread_id = thread_id

NEXT_STATE: BYTECODE_SCAN → DEEP_ANALYSIS


─── TRANSITION: DEEP_ANALYSIS ────────────────────────────────
ACTION:
    1. // Use LLM to synthesize a comprehensive technical summary
       technical_summary = Aegis.inference.resilientClient.analyze(
           context = {
               mods: unique_mods,
               bytecode_reports: unique_mods.map(m => m.bytecode_report),
               server_context: {
                   current_mod_count: active_server_mods.length,
                   current_memory_usage: Aegis.mcp.invoke("get_server_resources", {server_id: target_server_id}).memory_bytes,
                   existing_mixins: Aegis.mcp.invoke("list_files", {server_id: target_server_id, path: "/mods/"}).filter(f => f.name.endsWith(".jar"))
               }
           },
           system_prompt = MOD_EVALUATION_PROMPT
       )
    
    2. // Store the analysis
       Aegis.analysis_cache[thread_id] = technical_summary

NEXT_STATE: DEEP_ANALYSIS → BUILDING_UI


─── TRANSITION: BUILDING_UI ──────────────────────────────────
ACTION:
    1. // Build checkbox selection system for multi-mod batches
       checkbox_components = Vanguard.checkboxBuilder.build(
           mods = unique_mods,
           include_analysis = true
       )
       // Creates Discord Action Rows with:
       //   - Select Menu or Button Group for each mod
       //   - Each option labeled: "✅ ModName (v1.2.3)" / "⚠️ ModName (v1.2.3) - Collision Risk"
    
    2. // Build action buttons
       action_row = Vanguard.interactions.createActionRow([
           { custom_id: `approve:${thread_id}`, label: "🟢 Approve & Deploy", style: SUCCESS },
           { custom_id: `reject:${thread_id}`,  label: "🔴 Reject",          style: DANGER }
       ])
    
    3. Vanguard.post(thread, embed: {
           title: "📊 Mod Evaluation Report",
           fields: [
               FOR EACH mod IN unique_mods:
               {
                   name: mod.name,
                   value: f"**Version:** {mod.version}\n" +
                          f"**Mixin Count:** {mod.bytecode_report.mixins.count}\n" +
                          f"**Dependencies:** {mod.bytecode_report.dependencies.length} required\n" +
                          f"**Est. RAM Impact:** +{mod.bytecode_report.resources.memory_mb}MB\n" +
                          f"**Collision Risk:** {mod.bytecode_report.collision_risks.level}\n" +
                          f"**Summary:** {technical_summary.mod_summaries[mod.slug]}"
               }
           ],
           footer: "Select specific mods to approve, then click an action button."
       }, components: [checkbox_components, action_row])

NEXT_STATE: BUILDING_UI → AWAITING_ADMIN


─── STATE: AWAITING_ADMIN ────────────────────────────────────
GUARD: Only users with admin role IDs can interact with buttons/modals

ON_BUTTON_CLICK("approve:*"):
    1. // Verify admin permissions
       IF NOT is_admin(interaction.user):
           interaction.reply({ content: "⛔ Only administrators can approve suggestions.", ephemeral: true })
           RETURN
    
    2. // Get selected mods from checkbox state
       selected_mods = interaction.values  // Slugs of admin-chosen mods
       approved_mods = unique_mods.filter(m => m.slug IN selected_mods)
    
    3. // Show approval modal
       modal = Vanguard.modalDispatcher.create("approval_modal", {
           custom_id: `approve_submit:${thread_id}`,
           title: "Approve & Deploy Configuration",
           text_inputs: [
               {
                   custom_id: "optimization_notes",
                   label: "Optimization Notes / Config Instructions",
                   style: PARAGRAPH,
                   placeholder: "e.g., Disable world-gen biomes in config, link with KubeJS files...",
                   required: false
               },
               {
                   custom_id: "deployment_priority",
                   label: "Priority (low / normal / high)",
                   style: SHORT,
                   placeholder: "normal",
                   required: false
               }
           ]
       })
       interaction.showModal(modal)
    
    4. // On modal submit:
       optimization_notes = modal.getValue("optimization_notes")
       deployment_priority = modal.getValue("deployment_priority") || "normal"
       
       // Build staging file list
       staging_files = approved_mods.map(mod => ({
           staging_path: `/workspace/staging/mods/${mod.slug}-${mod.version}.jar`,
           production_path: `/home/container/mods/${mod.slug}-${mod.version}.jar`,
           file_type: "mod_jar",
           source_suggestion_thread_id: thread_id,
           admin_override_config: parseOverrideConfig(optimization_notes)
       }))
       
       // Create maintenance job
       DB: INSERT INTO maintenance_queue (pterodactyl_server_id, target_files, admin_override_notes, approved_by, status)
       VALUES (server_id, staging_files, optimization_notes, admin_id, 'pending')
       
       // Link suggestion thread to maintenance job
       DB: UPDATE suggestion_threads
       SET status = 'staged',
           admin_notes = optimization_notes,
           approved_by = admin_id,
           reviewed_at = NOW(),
           maintenance_job_id = (new job_id)
       WHERE thread_id = thread_id
       
       Vanguard.post(thread, embed: {
           title: "✅ Approved & Staged for Deployment",
           description: f"{approved_mods.length} mod(s) approved by <@{admin_id}>.\n" +
                        f"**Notes:** {optimization_notes || 'None'}\n\n" +
                        "📦 Mods will be deployed during the next low-activity window (0 players online).",
           color: GREEN
       })
       
       → TRANSITION to STAGING (Deployment Lifecycle)

ON_BUTTON_CLICK("reject:*"):
    1. IF NOT is_admin(interaction.user):
           interaction.reply({ content: "⛔ Only administrators can reject suggestions.", ephemeral: true })
           RETURN
    
    2. modal = Vanguard.modalDispatcher.create("rejection_modal", {
           custom_id: `reject_submit:${thread_id}`,
           title: "Rejection Reason",
           text_inputs: [{
               custom_id: "rejection_reason",
               label: "Reason for Rejection",
               style: PARAGRAPH,
               placeholder: "e.g., Incompatible with server modpack, performance concerns...",
               required: true
           }]
       })
       interaction.showModal(modal)
    
    3. // On modal submit:
       rejection_reason = modal.getValue("rejection_reason")
       
       // Aegis synthesizes a comprehensive rejection notice combining:
       //   - Admin's stated reason
       //   - Its own bytecode diagnostic data
       //   - Any relevant context (performance, conflicts, etc.)
       rejection_notice = Aegis.inference.resilientClient.compose(
           admin_reason = rejection_reason,
           bytecode_data = technical_summary,
           system_prompt = REJECTION_NOTICE_PROMPT
       )
       
       DB: UPDATE suggestion_threads
       SET status = 'rejected',
           admin_notes = rejection_reason,
           rejected_by = admin_id,
           reviewed_at = NOW()
       WHERE thread_id = thread_id
       
       Vanguard.post(thread, embed: {
           title: "❌ Suggestion Rejected",
           description: rejection_notice,
           color: RED
       })
       
       Vanguard.threadManager.lockThread(thread_id)
       → TRANSITION to CLOSING
```

---

## C. Cron-Based Automated Deployment Lifecycle

### Overview

Approved mods enter the maintenance queue and are staged in the sandbox. An asynchronous cron worker monitors player count via the Pterodactyl API. When the player count hits zero, Aegis executes the full deployment sequence: backup → file swap → restart → health check → changelog.

### State Diagram

```
[PENDING] ──cron tick──▶ [STAGING] ──files ready──▶ [READY] ──players=0──▶ [EXECUTING]
                                                                          │
                                                                   ┌──────┴──────┐
                                                              [BACKUP_CREATE] [BACKUP_VERIFY]
                                                                   │              │
                                                                   ▼              ▼
                                                              [FILE_SWAP] ◀────────┘
                                                                   │
                                                              [SERVER_STOP]
                                                                   │
                                                              [SERVER_START]
                                                                   │
                                                              [HEALTH_CHECK]
                                                                   │
                                                              [TPS_VALIDATION]
                                                                   │
                                                         ┌─────────┴─────────┐
                                                    [COMPLETED]          [FAILED]
                                                         │                    │
                                                  [CHANGELOG_PUBLISH]    [ROLLBACK]
                                                         │                    │
                                                    [IDLE]              [ROLLED_BACK]
                                                                              │
                                                                        [IDLE]
```

### Pseudocode

```
STATE MACHINE: DeploymentRunner
───────────────────────────────

─── STATE: PENDING ───────────────────────────────────────────
DESCRIPTION: Maintenance job has been created but staging has not begun.

TRIGGER: A new row is inserted into maintenance_queue with status = 'pending'
ACTION:
    1. Aegis.cron.scheduler.registerJob({
           job_id: maintenance_job.job_id,
           name: f"deployment_{maintenance_job.job_id}",
           interval: "*/60 * * * * *",  // Check every 60 seconds
           handler: checkAndStage
       })

NEXT_STATE: Awaits cron tick


─── TRANSITION: PENDING → STAGING ────────────────────────────
TRIGGER: Cron tick fires checkAndStage()
GUARD:   maintenance_job.status === 'pending'
ACTION:
    1. DB: UPDATE maintenance_queue SET status = 'staging' WHERE job_id = job_id
    
    2. Aegis.reporter.streamLog(suggestion_thread_id, "📦 Building deployment payload in sandbox...")
    
    3. // Build the staging payload inside sandbox
       FOR EACH file IN maintenance_job.target_files:
       
       // If file is a mod JAR, it should already be in /workspace/downloads/ from evaluation
       IF NOT sandbox.file_exists(file.staging_path):
           // Re-download if not present (e.g., after sandbox restart)
           Aegis.jarDownloader.download(file.mod_id, file.version, file.staging_path)
       
       // Apply admin override configurations
       IF file.admin_override_config:
           Aegis.sandbox.shellExec(`
               python3 /opt/skills/config-override.py \
                   --jar="${file.staging_path}" \
                   --overrides='${JSON.stringify(file.admin_override_config)}' \
                   --output="${file.staging_path}"
           `)
           // config-override.py extracts default configs from the JAR,
           // applies the admin's modifications, and repacks the JAR
       
       // Validate the staged file
       validation = Aegis.sandbox.shellExec(`
           java -jar /opt/skills/jar-validator.jar "${file.staging_path}"
       `)
       IF validation.exit_code !== 0:
           Aegis.reporter.streamLog(suggestion_thread_id,
               f"⚠️ Validation failed for {file.staging_path}: {validation.stderr}")
           // Skip this file and continue, or fail the job based on severity
    
    4. DB: UPDATE maintenance_queue SET status = 'ready' WHERE job_id = job_id
    5. Aegis.reporter.streamLog(suggestion_thread_id, "✅ Staging complete. Waiting for low-activity window...")

NEXT_STATE: STAGING → READY


─── STATE: READY ─────────────────────────────────────────────
DESCRIPTION: Staged files are ready. Waiting for player count to hit 0.

TRIGGER: Cron tick fires checkPlayerCount()
GUARD:   maintenance_job.status === 'ready'
ACTION:
    1. player_count = Aegis.mcp.invoke("get_player_count", {server_id: server_id})
    
    2. IF player_count > 0:
       // Not yet; check again next tick
       // Optionally: post a status update if players are low
       IF player_count <= 3 AND NOT low_player_warning_sent:
           Aegis.reporter.streamLog(suggestion_thread_id,
               f"📊 {player_count} player(s) online. Deployment will begin when the server is empty.")
           low_player_warning_sent = true
       RETURN  // Stay in READY state
    
    3. IF player_count === 0:
       → TRANSITION to EXECUTING

NEXT_STATE: Awaits zero-player condition


─── TRANSITION: READY → EXECUTING ────────────────────────────
TRIGGER: Player count === 0 confirmed
ACTION:
    1. DB: UPDATE maintenance_queue
       SET status = 'executing', execution_timestamp = NOW(), player_count_at_execution = 0
       WHERE job_id = job_id
    
    2. Aegis.reporter.streamLog(suggestion_thread_id, "🚀 Deployment sequence initiated!")
    
    3. → EXECUTE STEP: backup_create


─── STEP: backup_create ──────────────────────────────────────
ACTION:
    1. Aegis.reporter.streamLog(suggestion_thread_id, "💾 Creating full server backup...")
    
    2. DB: INSERT INTO deployment_audit (job_id, step, step_order, status, started_at)
       VALUES (job_id, 'backup_create', 1, 'started', NOW())
    
    3. backup_response = Aegis.mcp.invoke("create_backup", {
           server_id: server_id,
           name: f"pre-deploy-{job_id}",
           ignored: []  // Full backup, no exclusions
       })
    
    4. // Poll for backup completion (backup is async in Pterodactyl)
       backup_uuid = backup_response.uuid
       WHILE NOT backup_complete:
           SLEEP(5 seconds)
           backup_status = Aegis.mcp.invoke("get_backup_status", {server_id: server_id, backup_uuid: backup_uuid})
           IF backup_status.state === 'completed':
               backup_complete = true
           IF backup_status.state === 'failed':
               → TRANSITION to FAILED (reason: "Backup creation failed")
           IF elapsed_time > 10 minutes:
               → TRANSITION to FAILED (reason: "Backup creation timed out")
    
    5. DB: UPDATE maintenance_queue SET backup_uuid = backup_uuid WHERE job_id = job_id
    6. DB: UPDATE deployment_audit SET status = 'success', completed_at = NOW() WHERE job_id = job_id AND step = 'backup_create'
    7. Aegis.reporter.streamLog(suggestion_thread_id, f"✅ Backup created: {backup_uuid}")

NEXT_STEP: backup_verify


─── STEP: backup_verify ──────────────────────────────────────
ACTION:
    1. Aegis.reporter.streamLog(suggestion_thread_id, "🔍 Verifying backup integrity...")
    
    2. DB: INSERT INTO deployment_audit (job_id, step, step_order, status, started_at)
       VALUES (job_id, 'backup_verify', 2, 'started', NOW())
    
    3. // Download backup checksum and verify
       backup_info = Aegis.mcp.invoke("get_backup_status", {server_id: server_id, backup_uuid: backup_uuid})
       IF backup_info.size_bytes < MINIMUM_BACKUP_SIZE:
           → TRANSITION to FAILED (reason: "Backup appears corrupted (unusually small)")
       
       // Check backup is in a restorable state
       IF backup_info.state !== 'completed' OR NOT backup_info.is_successful:
           → TRANSITION to FAILED (reason: "Backup verification failed")
    
    4. DB: UPDATE deployment_audit SET status = 'success', completed_at = NOW()
       WHERE job_id = job_id AND step = 'backup_verify'
    5. Aegis.reporter.streamLog(suggestion_thread_id, "✅ Backup verified successfully")

NEXT_STEP: file_swap


─── STEP: file_swap ──────────────────────────────────────────
ACTION:
    1. Aegis.reporter.streamLog(suggestion_thread_id, "📂 Swapping staged files into production...")
    
    2. DB: INSERT INTO deployment_audit (job_id, step, step_order, status, started_at)
       VALUES (job_id, 'file_swap', 3, 'started', NOW())
    
    3. FOR EACH file IN maintenance_job.target_files:
       // Read the staged file from sandbox
       file_content = Aegis.sandbox.fileBridge.readFromSandbox(file.staging_path)
       
       // Write to production via Pterodactyl file manager
       Aegis.mcp.invoke("write_file", {
           server_id: server_id,
           path: file.production_path,
           content: file_content
       })
       
       Aegis.reporter.streamLog(suggestion_thread_id,
           f"  📄 Written: {file.production_path}")
    
    4. // Apply any config modifications
       IF maintenance_job.admin_override_notes:
           config_overrides = parseOverrideConfig(maintenance_job.admin_override_notes)
           FOR EACH override IN config_overrides:
               Aegis.mcp.invoke("write_file", {
                   server_id: server_id,
                   path: override.target_path,
                   content: override.content
               })
    
    5. DB: UPDATE deployment_audit SET status = 'success', completed_at = NOW()
       WHERE job_id = job_id AND step = 'file_swap'
    6. Aegis.reporter.streamLog(suggestion_thread_id, "✅ All files deployed to production")

NEXT_STEP: server_stop


─── STEP: server_stop ────────────────────────────────────────
ACTION:
    1. Aegis.reporter.streamLog(suggestion_thread_id, "🛑 Stopping server for clean restart...")
    
    2. DB: INSERT INTO deployment_audit (job_id, step, step_order, status, started_at)
       VALUES (job_id, 'server_stop', 4, 'started', NOW())
    
    3. // Send in-game warning (via console command)
       Aegis.mcp.invoke("send_command", {
           server_id: server_id,
           command: "say §c[Aegis] §eServer restarting for mod updates in 10 seconds..."
       })
       SLEEP(10 seconds)
    
    4. // Issue graceful stop
       Aegis.mcp.invoke("stop_server", {server_id: server_id})
       
       // Wait for server to fully stop (poll status)
       max_wait = 60 seconds
       elapsed = 0
       WHILE elapsed < max_wait:
           SLEEP(5 seconds)
           elapsed += 5
           power_state = Aegis.mcp.invoke("get_server_resources", {server_id: server_id}).current_state
           IF power_state === 'offline':
               BREAK
       
       IF power_state !== 'offline':
           // Force kill if graceful stop failed
           Aegis.mcp.invoke("kill_server", {server_id: server_id, confirm: true})
           SLEEP(5 seconds)
    
    5. DB: UPDATE deployment_audit SET status = 'success', completed_at = NOW()
       WHERE job_id = job_id AND step = 'server_stop'
    6. Aegis.reporter.streamLog(suggestion_thread_id, "✅ Server stopped")

NEXT_STEP: server_start


─── STEP: server_start ───────────────────────────────────────
ACTION:
    1. Aegis.reporter.streamLog(suggestion_thread_id, "▶️ Starting server...")
    
    2. DB: INSERT INTO deployment_audit (job_id, step, step_order, status, started_at)
       VALUES (job_id, 'server_start', 5, 'started', NOW())
    
    3. Aegis.mcp.invoke("start_server", {server_id: server_id})
    
    4. // Stream live console logs to the thread via webhook
       console_sub = Aegis.mcp.subscribeResource("pterodactyl://servers/{server_id}/console")
       console_sub.on('update', (data) => {
           Aegis.reporter.streamLog(suggestion_thread_id, f"`{data.line}`")
       })
    
    5. // Wait for server to fully boot (monitor for "Done" message)
       max_boot_wait = 180 seconds  // 3 minutes
       elapsed = 0
       boot_complete = false
       WHILE elapsed < max_boot_wait:
           SLEEP(5 seconds)
           elapsed += 5
           IF console_stream.lastLine.contains("Done (") AND console_stream.lastLine.contains("s)!"):
               boot_complete = true
               BREAK
       
       IF NOT boot_complete:
           → TRANSITION to FAILED (reason: "Server failed to boot within timeout")
    
    6. DB: UPDATE deployment_audit SET status = 'success', completed_at = NOW()
       WHERE job_id = job_id AND step = 'server_start'
    7. Aegis.reporter.streamLog(suggestion_thread_id, "✅ Server started successfully")

NEXT_STEP: health_check


─── STEP: health_check ───────────────────────────────────────
ACTION:
    1. Aegis.reporter.streamLog(suggestion_thread_id, "🏥 Running health checks...")
    
    2. DB: INSERT INTO deployment_audit (job_id, step, step_order, status, started_at)
       VALUES (job_id, 'health_check', 6, 'started', NOW())
    
    3. // Wait 15 seconds for post-boot stabilization
       SLEEP(15 seconds)
    
    4. // Check for crash indicators in recent console output
       recent_logs = Aegis.mcp.invoke("get_console_output", {server_id: server_id, lines: 100})
       crash_indicators = recent_logs.filter(line =>
           line.includes("Crash report") OR
           line.includes("FATAL") OR
           line.includes("Shutdown")
       )
       
       IF crash_indicators.length > 0:
           → TRANSITION to FAILED (reason: "Crash indicators detected in console output")
    
    5. // Check server resources are within normal bounds
       resources = Aegis.mcp.invoke("get_server_resources", {server_id: server_id})
       IF resources.memory_bytes > MEMORY_LIMIT_BYTES * 0.95:
           Aegis.reporter.streamLog(suggestion_thread_id,
               "⚠️ Memory usage is above 95% of allocated limit. Monitoring closely...")
    
    6. DB: UPDATE deployment_audit SET status = 'success', completed_at = NOW()
       WHERE job_id = job_id AND step = 'health_check'

NEXT_STEP: tps_validation


─── STEP: tps_validation ─────────────────────────────────────
ACTION:
    1. Aegis.reporter.streamLog(suggestion_thread_id, "📊 Validating TPS stability...")
    
    2. DB: INSERT INTO deployment_audit (job_id, step, step_order, status, started_at)
       VALUES (job_id, 'tps_validation', 7, 'started', NOW())
    
    3. // Sample TPS over 3 readings at 10-second intervals
       tps_readings = []
       FOR i IN range(3):
           SLEEP(10 seconds)
           tps_response = Aegis.mcp.invoke("send_command", {server_id: server_id, command: "tps"})
           // Parse TPS from response
           tps_value = parseFloat(tps.match(/TPS:\s*([\d.]+)/)?.[1])
           tps_readings.append(tps_value)
       
       avg_tps = average(tps_readings)
       min_tps = min(tps_readings)
    
    4. IF avg_tps >= 19.0 AND min_tps >= 18.0:
           health_check_passed = true
       ELSE IF avg_tps >= 15.0:
           Aegis.reporter.streamLog(suggestion_thread_id,
               f"⚠️ TPS is below optimal ({avg_tps.toFixed(1)}) but functional. Monitoring...")
           health_check_passed = true  // Acceptable but sub-optimal
       ELSE:
           → TRANSITION to FAILED (reason: f"TPS critically low: {avg_tps.toFixed(1)}")
    
    5. DB: UPDATE maintenance_queue
       SET tps_at_completion = avg_tps, health_check_passed = health_check_passed
       WHERE job_id = job_id
    
    6. DB: UPDATE deployment_audit SET status = 'success', completed_at = NOW()
       WHERE job_id = job_id AND step = 'tps_validation'
    
    7. Aegis.reporter.streamLog(suggestion_thread_id,
           f"✅ TPS validated: {avg_tps.toFixed(2)} (min: {min_tps.toFixed(2)})")

NEXT_STEP: changelog_publish


─── STEP: changelog_publish ──────────────────────────────────
ACTION:
    1. Aegis.reporter.streamLog(suggestion_thread_id, "📝 Publishing changelog...")
    
    2. DB: INSERT INTO deployment_audit (job_id, step, step_order, status, started_at)
       VALUES (job_id, 'changelog_publish', 8, 'started', NOW())
    
    3. // Generate engaging, user-centric changelog
       changelog = Aegis.inference.resilientClient.compose(
           context = {
               deployed_mods: unique_mods.filter(m => m.status === "approved"),
               technical_summary: technical_summary
           },
           system_prompt = CHANGELOG_GENERATION_PROMPT
           // Prompt instructs LLM to produce:
           //   - Exciting, community-friendly language
           //   - Key mod features and mechanics highlights
           //   - Author credits and links
           //   - Any known caveats or config notes
       )
    
    4. Vanguard.post(changelogs_channel_id, embed: {
           title: "🆕 Server Update — New Mods Added!",
           description: changelog,
           color: GREEN,
           footer: f"Deployed by Aegis | {new Date().toLocaleDateString()}"
       })
    
    5. DB: UPDATE deployment_audit SET status = 'success', completed_at = NOW()
       WHERE job_id = job_id AND step = 'changelog_publish'

NEXT_STEP: → COMPLETED


─── TRANSITION: COMPLETED ────────────────────────────────────
ACTION:
    1. DB: UPDATE maintenance_queue SET status = 'completed' WHERE job_id = job_id
    2. DB: UPDATE suggestion_threads SET status = 'deployed' WHERE maintenance_job_id = job_id
    
    3. Aegis.reporter.streamLog(suggestion_thread_id,
           "🎉 Deployment complete! All systems operational.")
    
    4. Vanguard.threadManager.archiveThread(suggestion_thread_id)
    5. Aegis.cron.scheduler.unregisterJob(job_id)

NEXT_STATE: IDLE


─── TRANSITION: FAILED → ROLLBACK ────────────────────────────
TRIGGER: Any step returns a failure condition
ACTION:
    1. Aegis.reporter.streamLog(suggestion_thread_id,
           f"❌ Deployment FAILED at step '{failed_step}': {failure_reason}")
    2. Aegis.reporter.streamLog(suggestion_thread_id, "🔄 Initiating automatic rollback...")
    
    3. DB: UPDATE maintenance_queue SET status = 'failed' WHERE job_id = job_id
    4. DB: UPDATE deployment_audit SET status = 'failed', error_message = failure_reason
       WHERE job_id = job_id AND step = failed_step AND status = 'started'
    
    5. // If backup was created, restore it
       IF backup_uuid:
           Aegis.reporter.streamLog(suggestion_thread_id,
               f"🔄 Restoring from backup {backup_uuid}...")
           
           // Stop server first
           current_power = Aegis.mcp.invoke("get_server_resources", {server_id: server_id}).current_state
           IF current_power !== 'offline':
               Aegis.mcp.invoke("stop_server", {server_id: server_id})
               SLEEP(10 seconds)
           
           // Restore backup
           Aegis.mcp.invoke("restore_backup", {server_id: server_id, backup_uuid: backup_uuid, confirm: true})
           
           // Restart server
           Aegis.mcp.invoke("start_server", {server_id: server_id})
           
           // Validate rollback
           SLEEP(30 seconds)
           // ... (similar health check as above)
       
    6. DB: UPDATE maintenance_queue SET status = 'rolled_back' WHERE job_id = job_id
    7. Aegis.reporter.streamLog(suggestion_thread_id, "✅ Rollback completed. Server restored to pre-deployment state.")
    
    8. // Notify admins
       Vanguard.post(admin_channel_id, embed: {
           title: "⚠️ Deployment Failed & Rolled Back",
           description: f"Job {job_id} failed at step '{failed_step}': {failure_reason}\n" +
                        "Server has been restored from backup.",
           color: RED
       })

NEXT_STATE: IDLE
```

---

## Cross-Lifecycle Integration Points

| Integration Point | Lifecycles Involved | Mechanism |
|---|---|---|
| Suggestion Approval → Deployment | B → C | When admin clicks "Approve & Deploy", the suggestion thread's `maintenance_job_id` links to a new `maintenance_queue` row, transitioning from lifecycle B's `AWAITING_ADMIN` state to lifecycle C's `PENDING` state |
| Crash During Deployment | C | If the health check or TPS validation step detects a crash, Aegis can invoke the crash troubleshooting lifecycle (A) within the deployment thread to diagnose the failure before deciding whether to roll back |
| Admin Override Commands | A, B, C | Admin `@Vanguard` commands bypass normal state guards. For example, `@Vanguard force deploy job <id>` transitions a `READY` job directly to `EXECUTING` regardless of player count, with a confirmation step |
| Skill File Synthesis | A, B, C | Any lifecycle can trigger Aegis's skill synthesis engine if it encounters a gap in its tool set. New skills are persisted and available for all future lifecycle executions |
