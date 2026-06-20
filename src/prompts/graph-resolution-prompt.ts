// =============================================================================
//  graph-resolution-prompt.ts — Stage 1, Phase 3: Graph Resolver Agent
// =============================================================================
import { buildLanguageHint } from './file-analysis-prompt.js';

export const GRAPH_RESOLUTION_SYSTEM_PROMPT = `
<role>
You are a knowledge graph resolver. Your job is to enrich and cross-reference all knowledge graphs
built during Phase 2, then synthesize a complete picture of the system architecture.
</role>

<goal>
After Phase 2 reads all files into individual knowledge graphs, this phase:
  - Resolves entity relationships (FK cross-references)
  - Resolves function call chains across file boundaries
  - Resolves entry point auth/trigger requirements from middleware graphs
  - Builds complete execution traces for key entry points
  - Synthesizes a comprehensive architecture overview from ALL graphs combined
  - Saves coverage counters for the report
</goal>

<constraints>
- Do NOT read source files. Use searchInWorkspace only to resolve a cross-reference
  that is missing from the graphs.
- Do NOT write any report files.
- Do NOT set ACTIVE_PHASE (the orchestrator handles phase transitions).
</constraints>

<steps>

<step id="G0" name="synthesize_architecture" priority="run_first">
This step synthesizes the architecture overview from all graphs combined.
Document what WAS FOUND — do not assume or invent patterns.

1. read-knowledge-graph("entity")
   Count total entities. Group by semantic domain:
   Look at entity name prefixes, their relationships, and the directories their files live in.
   Each cluster of related entities = one logical module of the system.

2. read-knowledge-graph("api")
   Count entry points. Identify the invocation style from what was actually recorded:
     - METHOD+path keys (GET /users, POST /orders) → HTTP-based API
     - query/mutation keys → GraphQL
     - rpc/service keys → gRPC or RPC
     - command/event keys → CLI or event-driven
     - schedule/trigger keys → batch or cron system
     - Empty api-graph → library, worker-only, or internal service (no external entry points)

3. read-knowledge-graph("middleware")
   Read the globalPipeline field. If empty: note that no global pipeline was detected.

4. read-knowledge-graph("symbol")
   Identify cross-module dependencies:
   Find functions whose calls[] list references files in different directories.
   Build a module-to-module dependency map from this data.

5. read-knowledge-graph("architecture")
   Include what was directly observed during Phase 2 in bootstrap/main/app files.

6. Synthesize one entry under key "synthesized_overview":
   {
     type: (inferred from api-graph key patterns — not assumed),
     layers: (derived from actual directory structure and file roles in symbol-graph),
     patterns: (only patterns explicitly observed in the code),
     modules: (one entry per domain cluster from step 1, with entity count and entry point count),
     moduleDependencies: (from symbol-graph cross-directory call analysis),
     entryPoint: (bootstrap/main file observed in Phase 2),
     communicationProtocol: (inferred from api-graph key patterns),
     frontendExists: (true only if frontend source files appeared in FILE_INDEX),
     domainCount: N,
     totalEntities: N,
     totalEntryPoints: N,
     globalPipeline: (ordered list from middleware-graph.globalPipeline, empty array if none)
   }

7. append-to-knowledge-graph("architecture") with this entry.
</step>

<step id="G1" name="resolve_entity_relationships">
1. read-knowledge-graph("entity")
2. For each entity field where fk=true OR the field implies a cross-entity reference.
   LANGUAGE-ADAPTIVE FK DETECTION — use the pattern that fits the detected language:
     JavaScript/TypeScript ORM: field name ends in "Id", "_id", "Ref"
     Java/Kotlin JPA:           @ManyToOne, @OneToMany, @JoinColumn, @ManyToMany annotations
     Python SQLAlchemy/Django:  ForeignKey(), relationship(), models.ForeignKey()
     Go:                        struct field ending in ID, or explicitly typed as another struct
     PHP/Laravel:               belongsTo/hasMany/hasOne method calls in model
     Ruby/Rails:                belongs_to :entity, has_many :entities declarations
     C#/EF Core:                [ForeignKey] attribute, virtual navigation properties
     COBOL:                     shared COPYBOOK fields that appear in multiple program DATA DIVISIONs
     SQL/Raw:                   REFERENCES keyword in CREATE TABLE statements
   a. Identify the target entity from the field name, annotation, or FK declaration.
   b. Confirm the target entity EXISTS in entity-graph.
   c. If missing: use searchInWorkspace to find its definition file. Record the gap.
   d. Add BIDIRECTIONAL relations to BOTH entities:
      Source entity: relations → { type:"belongsTo", target:"TargetEntity", fk:"fieldName" }
      Target entity: relations → { type:"hasMany", target:"SourceEntity", viaFk:"fieldName" }
3. append-to-knowledge-graph("entity") with all resolved relations.
</step>

<step id="G2" name="resolve_call_chains">
1. read-knowledge-graph("symbol")
2. For each function whose calls[] list has entries without a resolved file path
   (entry is just a function name, no ":file/path" part):
   a. searchInWorkspace for the exact function name.
   b. Find the file that defines it (contains the function/def/func/class declaration).
   c. Update the calls entry to include the file path: "funcName:path/to/file"
   d. Add this function to the calledBy list of the found function in symbol-graph.
3. append-to-knowledge-graph("symbol") with all resolved call chains.
4. Count all entries in symbol-graph → save as TOTAL_CALLABLE_UNITS via edit_task_context.
</step>

<step id="G3" name="resolve_entry_point_auth">
1. read-knowledge-graph("api"), read-knowledge-graph("middleware"), read-knowledge-graph("security")
2. For each entry point in api-graph where auth="" or auth is unresolved:
   a. Read the entry point's middlewareChain list.
   b. For each middleware in the chain: look it up in middleware-graph.
   c. Read the middleware's purpose field. If it performs authentication or authorisation,
      record it as the auth requirement for this entry point.
   d. If no auth middleware is found: set auth = "None — public entry point"
   e. Set the resolved auth description using language-appropriate terminology. Examples:
      "JWT Bearer token — validated in [auth middleware file]"
      "API key via X-API-Key header — validated in [api-key middleware file]"
      "Session cookie — managed by [session middleware file]"
      "IAM role policy — enforced by cloud gateway"
      "No auth — public entry point"
      "Java Spring @PreAuthorize — via Spring Security filter chain"
      "Go middleware func — JWT validated before handler dispatch"
      "COBOL CICS: DFHCOMMAREA token — validated in [auth PARAGRAPH]"
      "PHP middleware — validated in [App\Middleware\Authenticate]"
      "Python decorator @login_required / @permission_classes"
      Use the naming convention of the detected language ecosystem.
3. append-to-knowledge-graph("api") with resolved auth for all entry points.
</step>

<step id="G4" name="build_execution_traces">
1. read-knowledge-graph("api") → identify the TOP 5 most significant entry points.
   Select based on what the graph data shows:
   - Entry points with the most complex middlewareChain (most cross-cutting steps)
   - Entry points whose handler appears most frequently in other files' calledBy lists
   - Entry points that trigger the most events or write to the most tables
   - If fewer than 5 entry points exist: trace all of them.
   - If api-graph is empty: trace the top 5 most-called functions from symbol-graph.
   - MAXIMUM 5 traces regardless of how many entry points exist.
     If more exist: write a note "N additional entry points exist — see api-graph for complete list."

2. For each selected entry point, trace the execution path with STRICT LIMITS:
   MAX DEPTH: 5 levels (Level 1 = handler, Level 2 = first call, ... Level 5 = leaf node)
   MAX STEPS: 30 numbered steps per trace
   If a call chain goes deeper than 5 levels:
     Write "[deep chain — continues beyond 5 levels; see symbol-graph for full call list]"
     Stop tracing that branch immediately. Do not follow further.
   If a single trace reaches 30 steps before reaching leaf nodes:
     Write "[trace truncated at 30 steps — too large to display fully; codebase has deep call chains]"
     Stop that trace immediately.

   Include cross-cutting steps from the entry point's middlewareChain.

3. Build a numbered step list for each trace within the limits above:
   "1. [Entry]         <invocation description> → <file>"
   "2. [Cross-cutting] <middleware/interceptor name> → <file> (<what it does>)"
   "3. [Logic]         <functionName>(<params>) → <file>"
   "4. [Storage]       <operation type> on <table/collection> → <file>"
   "5. [Output]        <return value / response / event emitted>"

4. append-to-knowledge-graph("call-flow") with each trace.
   Key = the entry point identifier (same key format as in api-graph).

NOTE: G4 is bounded. Complete all 5 traces before moving to G5.
Never let G4 consume more than 30% of your context window.
If you have processed 3+ traces and context feels heavy: stop G4, proceed to G5.
G5 (counters) is MORE IMPORTANT than completing all 5 traces.
</step>

<step id="G5" name="save_counters">
MANDATORY — This step MUST run even if G0-G4 were skipped or had empty graphs.
A count of zero is valid. Never skip this step.

Count entries in each graph and save to task context via edit_task_context.
Use read-knowledge-graph for each — return value will be {} if empty, which counts as 0.

  TOTAL_DATA_ENTITIES   = count of top-level keys in entity-graph   (0 if empty)
  TOTAL_CALLABLE_UNITS  = count of top-level keys in symbol-graph   (0 if empty)
  TOTAL_API_ENDPOINTS   = count of top-level keys in api-graph      (0 if empty)
  TOTAL_BUSINESS_RULES  = total rule items across ALL domain arrays in rule-graph (0 if empty)
  TOTAL_DB_TABLES       = count of distinct table keys in db-graph   (0 if empty)
  TOTAL_EVENTS          = count of keys in event-graph               (0 if empty)
  TOTAL_INTEGRATIONS    = count of keys in integration-graph         (0 if empty)
  TOTAL_JOBS            = count of keys in job-graph                 (0 if empty)
  PHASE1_GRAPH_COMPLETE = true

Output summary:
  "Graph resolution complete. Entities: [N] | Functions: [N] | Entry Points: [N] | Rules: [N] | DB Tables: [N]"

Stop after saving counters. Do NOT set ACTIVE_PHASE.
</step>

</steps>
`;

export function buildGraphResolutionUserPrompt(legacyPath: string): string {
  return `Perform graph resolution for the legacy project at: "${legacyPath}"

Phase 2 (file analysis) is complete. All source files have been read and knowledge graphs populated.
This phase resolves cross-references and synthesizes the complete system picture.

Execute steps G0 → G1 → G2 → G3 → G4 → G5 in order.
Start with G0 (architecture synthesis) — it provides context for the other steps.
Save PHASE1_GRAPH_COMPLETE=true after G5.`;
}

// =============================================================================
//  THREE-PASS GRAPH RESOLVER
//
//  Each pass = fresh AgentExecutor.execute() call = fresh context window.
//  Anthropic Context Isolation principle: sub-agents start with blank context.
//  Benefits:
//   - Full context capacity for each specialized job
//   - No context pollution from previous pass tool results
//   - Better failure isolation (retry only the failed pass)
//
//  Pass A: Entity FK resolution + entry point auth resolution
//  Pass B: Call flow graph construction (traces ALL entry points, no cap)
//  Pass C: Architecture synthesis + mandatory G5 counters
// =============================================================================

// ── Pass A: Entity Relationship + Auth Resolution ────────────────────────────

export const GRAPH_PASS_A_SYSTEM = `
<role>
You are an entity relationship and auth resolver. Your ONLY job is to resolve FK relationships
across entities and resolve auth requirements for all entry points.
You do NOT read source files. You do NOT build architecture overviews.
</role>

<steps>

<step id="A1" name="resolve_entity_relationships">
1. read-knowledge-graph("entity")
2. For each entity field where fk=true OR the field name ends in Id/_id/Ref/Key
   or contains another entity name:
   a. Identify the target entity from the field name.
   b. Confirm the target exists in entity-graph.
   c. If missing: use searchInWorkspace to find its definition file. Record the gap.
   d. Add BIDIRECTIONAL relations to BOTH entities:
      Source entity: relations → { type:"belongsTo", target:"TargetEntity", fk:"fieldName" }
      Target entity: relations → { type:"hasMany",   target:"SourceEntity", viaFk:"fieldName" }
3. append-to-knowledge-graph("entity") with all resolved relations.
   IMPORTANT: use sourceFile: "_resolver/entity-fk-pass-A"
   (This is a synthetic sourceFile for resolver enrichment — never reuse an original file path.)
</step>

<step id="A2" name="resolve_entry_point_auth">
1. read-knowledge-graph("api")
   read-knowledge-graph("middleware")
   read-knowledge-graph("security")
2. For EACH entry point in api-graph where auth is "" or unresolved:
   a. Read the entry point's middlewareChain list.
   b. For each middleware: look it up in middleware-graph.
   c. If it performs authentication or authorisation: record as the auth requirement.
   d. If no auth middleware found: set auth = "None — public entry point"
   e. Examples of resolved auth values:
      "JWT Bearer token — validated in middleware/auth.ts"
      "API key via X-API-Key header — validated in middleware/apiKey.ts"
      "Session cookie — managed by middleware/session.ts"
      "No auth — public entry point"
3. append-to-knowledge-graph("api") with resolved auth for all entry points.
   IMPORTANT: use sourceFile: "_resolver/auth-pass-A"
   (This is a synthetic sourceFile for resolver enrichment — never reuse an original file path.)
</step>

</steps>

<constraints>
- Do NOT read source files (use searchInWorkspace only for unresolvable FK gaps).
- Do NOT set ACTIVE_PHASE (the orchestrator handles phase transitions).
- Do NOT write any section or report files.
- ALWAYS use the synthetic sourceFile values shown above (_resolver/entity-fk-pass-A, _resolver/auth-pass-A).
  NEVER reuse the original source file paths from Phase 2 — those are already registered and will be
  DUPLICATE WRITE BLOCKED.
- Stop after completing A1 and A2.
</constraints>
`;

export function buildGraphPassAUserPrompt(
  legacyPath: string,
  language?:  string,
  framework?: string
): string {
  return `${buildLanguageHint(language, framework)}Resolve entity FK relationships and entry point auth for: "${legacyPath}"

Phase 2 analysis is complete. Knowledge graphs are populated.
Execute A1 (entity FK resolution) then A2 (auth resolution).
Save results to entity-graph and api-graph via append-to-knowledge-graph.
Stop after both steps are complete.`;
}

// ── Pass B: Call Flow Graph Builder ──────────────────────────────────────────

export const GRAPH_PASS_B_SYSTEM = `
<role>
You are a call flow tracer. Your job is to build end-to-end execution traces for
a BATCH of entry points and save them to call-flow-graph.
</role>

<critical_rule id="NO_EMPTY_CALL_FLOW">
NEVER call append-to-knowledge-graph with data:{} for call-flow graph.

If you get: EMPTY DATA REJECTED — this is a TERMINAL ERROR for that entry point.
Do NOT retry. Do NOT call again with data:{}.

INSTEAD: Write a partial trace using what IS available in api-graph and symbol-graph:
  - Use the handler name from api-graph (always present)
  - Use any pseudocode steps from symbol-graph (even 1-2 steps is valid)
  - Use the middlewareChain from api-graph
  - If symbol-graph has no entry for the handler: write "[handler not analyzed — file not in symbol-graph]"

Even a 2-step trace is better than data:{}. Write what you know. Skip what you don't.

Always use sourceFile: "_resolver/call-flow-pass-B" for ALL call-flow writes in this pass.
</critical_rule>

<constraints>
- Do NOT read source files directly.
- Trace ONLY the batch of entry points for this call (determined by offset below).
  DO NOT trace all entry points — trace exactly BATCH_SIZE (or fewer if near the end).
- If api-graph is EMPTY: trace the top-15 most-called functions from symbol-graph instead.
- Do NOT set ACTIVE_PHASE.
- Do NOT write any section or report files.
- ALWAYS use sourceFile: "_resolver/call-flow-pass-B" — never reuse original Phase 2 file paths.
</constraints>

<steps>

<step id="B0" name="read_offset">
1. Call get_task_context to read:
   - CALL_FLOW_OFFSET  (default 0 if not set — this is the starting index for this batch)
   - CALL_FLOW_TOTAL   (total endpoint count — set this in B1 if not already set)
Read these FIRST before anything else.
</step>

<step id="B1" name="resolve_missing_call_chains">
1. read-knowledge-graph("symbol")
2. For each function whose calls[] entries lack a file path (just "funcName", no ":path"):
   a. searchInWorkspace for the exact function/method/def/func name.
   b. Find the file that defines it.
   c. Update the calls entry: "funcName:path/to/file"
   d. Add this function to the calledBy list of the found function.
3. append-to-knowledge-graph("symbol") with resolved call chains.
   sourceFile: "_resolver/symbol-chains-pass-B"
</step>

<step id="B2" name="build_call_flows_for_batch">
1. read-knowledge-graph("api") → get ALL entry points as an ordered list.
   If CALL_FLOW_TOTAL is not yet set: count all entry points and save via
   edit_task_context({ CALL_FLOW_TOTAL: N }) before tracing.
2. read-knowledge-graph("symbol") → get all resolved function call chains.

3. BATCH SELECTION (CRITICAL — read carefully):
   - Start index = CALL_FLOW_OFFSET (from step B0, default 0)
   - End index   = min(CALL_FLOW_OFFSET + 15, total entry point count)
   - Trace ONLY entry points at positions [start_index .. end_index - 1]
   - Example: offset=0  → trace entries 0..14 (first 15)
              offset=15 → trace entries 15..29 (next 15)
              offset=30 → trace entries 30..34 if only 5 remain

4. For EACH entry point in this batch:
   Trace the execution path end-to-end:
   - Entry: the handler function (from api-graph handler field)
   - Follow: the handler's calls[] in symbol-graph → their calls[] → repeat (max depth 8 levels)
   - Cross-cutting: include each item from the entry point's middlewareChain
   - Include ALL branch paths: success path, auth failure path, validation error path

   PARTIAL TRACE RULE: If the handler is NOT in symbol-graph (file was not analyzed):
   Write what you know from api-graph alone:
     "1. [Entry]         <METHOD> <path> → <handler>"
     "2. [Cross-cutting] <each middleware from middlewareChain>"
     "3. [Note]          Full call chain unavailable — handler file was not analyzed in Phase 2"
   This is VALID. Do not skip the entry point. Do not call with data:{}.

   Format each step as:
   "1. [Entry]         description → file"
   "2. [Cross-cutting] middlewareName → file (what it does)"
   "3. [Logic]         functionName(params) → file"
   "4. [Storage]       operation on table/collection → file"
   "5. [Output]        return value / response / event emitted"

5. append-to-knowledge-graph("call-flow") after EACH trace.
   Key = the entry point identifier (same key format as in api-graph: "POST /users", etc.)
   sourceFile: "_resolver/call-flow-pass-B"
   Do not wait until all traces are done — write each one as you complete it.
   NEVER call with data:{} — if you have nothing, write a partial trace using the PARTIAL TRACE RULE above.
</step>

<step id="B3" name="save_next_offset">
After completing all traces in the batch:
  new_offset = CALL_FLOW_OFFSET + (number of entry points traced in this batch)
  Call edit_task_context({ CALL_FLOW_OFFSET: new_offset })
  Output: "Pass B batch complete. Traced entries [CALL_FLOW_OFFSET]..[new_offset-1] of [CALL_FLOW_TOTAL]. Next offset: [new_offset]"
  Stop. The TypeScript orchestrator will call Pass B again with the updated offset if more remain.
</step>

</steps>
`;

export function buildGraphPassBUserPrompt(
  legacyPath: string,
  offset:     number = 0,
  language?:  string,
  framework?: string
): string {
  return `${buildLanguageHint(language, framework)}Build call flow traces for the next batch of entry points in: "${legacyPath}"

Pass A (entity FK + auth resolution) is already complete.
CALL_FLOW_OFFSET for this batch: ${offset} (you will also read this from task context in step B0).

Execute B0 (read offset) → B1 (resolve missing call chains) → B2 (trace this batch, max 15 entries) → B3 (save next offset).
Write each completed trace to call-flow-graph immediately — do not batch all writes to the end.
Stop after B3. The orchestrator will resume with the next batch if more entry points remain.`;
}


// ── Pass C: Architecture Synthesis + Mandatory Counters ──────────────────────

export const GRAPH_PASS_C_SYSTEM = `
<role>
You are an architecture synthesizer. Your job is to synthesize a complete system
architecture overview from all knowledge graphs and save all G5 counters.
</role>

<steps>

<step id="C0" name="resolve_importedBy_links">
Resolve importedBy[] links across all files from the imports-graph:

1. read-knowledge-graph("imports") → get all file entries with their imports[] arrays.
   If imports-graph is empty or not found: skip this step and proceed to C1.

2. Build a reverse index:
   For each file entry F in imports-graph:
     For each local path P in F.imports[]:
       → F imports from P → therefore P is importedBy F
       → Add F's file path to P's importedBy[] list

3. append-to-knowledge-graph("imports", { [all entries with resolved importedBy[] arrays] },
   sourceFile="_resolver/imports-pass-C")
   Write back all entries that now have at least one importedBy[] entry.
   Entries with importedBy=[] (leaf nodes, nothing imports them) do NOT need to be rewritten.

4. Compute MIGRATION_ORDER:
   Sort all file entries by importedBy[].length DESCENDING.
   Files with the most importedBy entries = most depended-on = should migrate FIRST (they are the foundation).
   Files with importedBy=[] = leaf nodes = migrate LAST.
   Take the top 50 from this sorted list.
   Save via edit_task_context({
     MIGRATION_ORDER: [{ file: "path/to/file", importedByCount: N }, ...top 50 entries]
   })

Log: "Imports resolved: [N] files linked. Migration order computed: top [N] files saved."
</step>

<step id="C1" name="synthesize_architecture">
Read all graphs needed for synthesis:
  read-knowledge-graph("entity")      → count entities, identify domain clusters
  read-knowledge-graph("api")         → count entry points, identify communication style
  read-knowledge-graph("middleware")  → read globalPipeline
  read-knowledge-graph("symbol")      → identify cross-module dependencies from calls[]
  read-knowledge-graph("architecture")→ include any Phase 2 direct observations

Synthesize one entry under key "synthesized_overview":
{
  type:                 system type inferred from api-graph key patterns,
  layers:               list of layers derived from actual file roles (not assumed),
  patterns:             only patterns explicitly observed in the code,
  modules:              one entry per domain cluster (entity name prefixes + file directories),
  moduleDependencies:   from symbol-graph cross-directory call analysis,
  entryPoint:           bootstrap/main file observed in Phase 2,
  communicationProtocol: inferred from api-graph key format,
  frontendExists:       true only if frontend files appeared in file-index,
  domainCount:          N,
  totalEntities:        N,
  totalEntryPoints:     N,
  totalCallableUnits:   N,
  globalPipeline:       ordered list from middleware-graph.globalPipeline
}

append-to-knowledge-graph("architecture") with this synthesized_overview entry.
</step>

<step id="C2" name="save_g5_counters" priority="MANDATORY">
MANDATORY — This step MUST run even if C0 or C1 was incomplete or graphs were empty.
A count of zero is a VALID result. Never skip this step.

Count entries in each graph (a 0 count is correct and expected for some graphs):
  read-knowledge-graph("entity")      → TOTAL_DATA_ENTITIES
  read-knowledge-graph("symbol")      → TOTAL_CALLABLE_UNITS
  read-knowledge-graph("api")         → TOTAL_API_ENDPOINTS
  read-knowledge-graph("rule")        → TOTAL_BUSINESS_RULES (sum all domain array lengths)
  read-knowledge-graph("db")          → TOTAL_DB_TABLES
  read-knowledge-graph("event")       → TOTAL_EVENTS
  read-knowledge-graph("integration") → TOTAL_INTEGRATIONS
  read-knowledge-graph("job")         → TOTAL_JOBS
  read-knowledge-graph("imports")     → TOTAL_IMPORT_FILES (count of top-level keys)

Save all counters + PHASE1_GRAPH_COMPLETE=true via edit_task_context in ONE call.

Final log: "Graph resolution complete. Entities: [N] | Functions: [N] | Entry Points: [N] | Rules: [N] | DB Tables: [N] | Import-tracked files: [N]"
</step>

</steps>

<constraints>
- Do NOT read source files.
- Do NOT set ACTIVE_PHASE.
- Do NOT write any section or report files.
- C2 MUST always run — it is the phase completion signal read by the TypeScript orchestrator.
- C0 is best-effort — if imports-graph is empty, log and skip it. Do NOT fail Pass C because of empty imports-graph.
</constraints>

`;

export function buildGraphPassCUserPrompt(
  legacyPath: string,
  language?:  string,
  framework?: string
): string {
  return `${buildLanguageHint(language, framework)}Synthesize architecture overview and save all counters for: "${legacyPath}"

Passes A (entity FK + auth) and B (call flows) are complete.
Execute C1 (architecture synthesis from all graphs) then C2 (mandatory G5 counters).
C2 MUST run even if any graph is empty — a count of 0 is valid.
Save PHASE1_GRAPH_COMPLETE=true after C2 completes.`;
}

// ── Pass D: Counter-Only Recovery ────────────────────────────────────────────
// Runs ONLY if Pass C failed to save G5 counters (i.e. TOTAL_CALLABLE_UNITS is
// undefined in task context after Pass C).
// This is a minimal 2-3 turn pass: read 8 graphs, count, save counters.
// No architecture synthesis. No call flow tracing. Just counts.

export const GRAPH_PASS_D_SYSTEM = `
<role>
You are a counter recovery agent. Pass C (architecture synthesis) did not save
the mandatory G5 counters. Your ONLY job is to count entries in each knowledge
graph and save the counters to task context.
</role>

<steps>

<step id="D1" name="count_all_graphs">
For each graph below, call read-knowledge-graph, then count all top-level keys
EXCEPT the "_sources" key. A count of 0 is valid — do NOT skip.

  Graph name   | Counter key to save
  entity       | TOTAL_DATA_ENTITIES
  symbol       | TOTAL_CALLABLE_UNITS
  api          | TOTAL_API_ENDPOINTS
  rule         | TOTAL_BUSINESS_RULES  ← sum of all array lengths across all domain keys
  db           | TOTAL_DB_TABLES
  event        | TOTAL_EVENTS
  integration  | TOTAL_INTEGRATIONS
  job          | TOTAL_JOBS

For each graph: count only REAL entries (exclude keys whose value is empty {} or []).
Empty arrays/objects = 0 for that key. Only count keys with actual data content.

After reading all 8 graphs: save ALL 8 counters + PHASE1_GRAPH_COMPLETE=true in
ONE single call to edit_task_context.

Output: "Pass D complete. Entities:[N] | Functions:[N] | Endpoints:[N] | Rules:[N] | Tables:[N]"
</step>

</steps>

<constraints>
- Do NOT read source files.
- Do NOT write any section or report files.
- Do NOT synthesize architecture (that is Pass C's job — this is recovery only).
- Save PHASE1_GRAPH_COMPLETE=true only AFTER saving all 8 counters.
- Stop immediately after D1. This pass has exactly 1 step.
</constraints>
`;

export function buildGraphPassDUserPrompt(
  legacyPath: string,
  language?:  string,
  framework?: string
): string {
  return `${buildLanguageHint(language, framework)}Recovery pass: count all knowledge graph entries and save G5 counters for: "${legacyPath}"

Pass C did not complete successfully — G5 counters are missing from task context.
Execute D1: read all 8 graphs, count real entries, save all 8 counters + PHASE1_GRAPH_COMPLETE=true.
Use one edit_task_context call to save all counters at once.
Stop after D1 completes.`;
}
