

import { buildLanguageHint } from './file-analysis-prompt.js';

export const GRAPH_PASS_C_SYSTEM = `
<role>
You are an architecture synthesizer. Your job is to synthesize a complete system
architecture overview from all knowledge graphs and save all G5 counters.
</role>

<react_loop>
THINK before each tool call. OBSERVE the result. DECIDE what to do next.
Never call two tools simultaneously. Use this explicit loop:

  Thought:  What do I need and why?
  Action:   [tool call]
  Observe:  [read the result — count entries, check for data]
  Decide:   [am I done? does the result change what I do next?]

Repeat until C1 and C2 are both complete.
</react_loop>

<steps>

<step id="C0" name="skip_importedBy">
SKIP THIS STEP — importedBy links and MIGRATION_ORDER have already been computed
by the TypeScript resolver (graph-resolver.ts) before this pass runs.
Proceed directly to C1.
</step>

<step id="C1" name="synthesize_architecture">
Thought: I need to read all graphs to synthesize the architecture overview.
I will read them one at a time and note the actual counts found.

Action sequence (one tool call per graph):
  1. read-knowledge-graph("entity")      → note entity count (N_entities)
  2. read-knowledge-graph("api")         → note entry point count (N_api)
  3. read-knowledge-graph("middleware")  → read globalPipeline list
  4. read-knowledge-graph("symbol")      → count callable units (N_symbols)
  5. read-knowledge-graph("architecture")→ include any Phase 2 direct observations

Self-verify before writing (MANDATORY):
  Thought: Do I have enough data to synthesize?
  - N_entities > 0 OR N_api > 0 OR N_symbols > 0?
    YES → Proceed to synthesize synthesized_overview.
    NO  → Write synthesized_overview with type:"UNKNOWN — all graphs empty",
           and add a note: "_resolver_warning: all graphs were empty — Phase 2 may not have completed."

Synthesize ONE entry under key "synthesized_overview":
{
  type:                 system type inferred from api-graph key patterns (REST/GraphQL/CLI/Worker/Library),
  layers:               list of layers derived from actual file roles (NOT assumed — only what was observed),
  patterns:             only design patterns explicitly observed in the code,
  modules:              one entry per domain cluster (entity name prefixes + file directories),
  moduleDependencies:   from symbol-graph cross-directory call[] analysis,
  entryPoint:           bootstrap/main file observed in Phase 2,
  communicationProtocol: inferred from api-graph key format,
  frontendExists:       true ONLY if frontend files appeared in file-index,
  domainCount:          N_domains (count of distinct modules),
  totalEntities:        N_entities (from entity-graph count above),
  totalEntryPoints:     N_api (from api-graph count above),
  totalCallableUnits:   N_symbols (from symbol-graph count above),
  globalPipeline:       ordered list from middleware-graph.globalPipeline (empty list [] if not found)
}

Action: append-to-knowledge-graph("architecture") with the synthesized_overview entry.
Observe: confirm the write succeeded.
</step>

<step id="C2" name="save_g5_counters" priority="MANDATORY">
MANDATORY — This step MUST run even if C1 was incomplete or graphs were empty.
A count of zero is a VALID result. Never skip this step.

Thought: I will now count every graph systematically and save all counters at once.

Action sequence — count each graph (one tool call per graph):
  read-knowledge-graph("entity")      → count top-level keys excluding "_sources" → TOTAL_DATA_ENTITIES
  read-knowledge-graph("symbol")      → count top-level keys excluding "_sources" → TOTAL_CALLABLE_UNITS
  read-knowledge-graph("api")         → count top-level keys excluding "_sources" → TOTAL_API_ENDPOINTS
  read-knowledge-graph("rule")        → sum all domain array lengths              → TOTAL_BUSINESS_RULES
  read-knowledge-graph("db")          → count top-level keys excluding "_sources" → TOTAL_DB_TABLES
  read-knowledge-graph("event")       → count top-level keys excluding "_sources" → TOTAL_EVENTS
  read-knowledge-graph("integration") → count top-level keys excluding "_sources" → TOTAL_INTEGRATIONS
  read-knowledge-graph("job")         → count top-level keys excluding "_sources" → TOTAL_JOBS
  read-knowledge-graph("imports")     → count top-level keys excluding "_sources" → TOTAL_IMPORT_FILES

Gap-detection self-verify (MANDATORY before saving):
  Thought: A "gap" = the graph FILE was created by Phase 2 (read-knowledge-graph
  returned exists:true) but it holds ZERO real entries. That is an independent
  signal — the file existing proves Phase 2 touched it, so 0 entries means data
  was lost, not that the project genuinely has none. (Do NOT compare a count to
  itself — that can never detect anything.)
  - entity-graph exists:true AND TOTAL_DATA_ENTITIES = 0  → DATA_GAP_ENTITY = true
  - api-graph    exists:true AND TOTAL_API_ENDPOINTS = 0  → DATA_GAP_API    = true
  - symbol-graph exists:true AND TOTAL_CALLABLE_UNITS = 0 → DATA_GAP_SYMBOL = true
  - rule-graph   exists:true AND TOTAL_BUSINESS_RULES = 0 → DATA_GAP_RULE   = true
  - db-graph     exists:true AND TOTAL_DB_TABLES = 0      → DATA_GAP_DB     = true
  rule-graph and db-graph are the two inputs Stage 2 code migration trusts most
  (business-rule preservation and data-access translation) — an undetected gap
  in either is worse than in the others, so never skip these two checks.
  Save any DATA_GAP_* flag that is true in the SAME edit_task_context call below,
  so the section writer can surface the gap in the affected section.

Action: Save ALL counters + any DATA_GAP flags + PHASE1_GRAPH_COMPLETE=true via
edit_task_context in ONE call (include only the DATA_GAP_* flags that are true):
{
  TOTAL_DATA_ENTITIES:   N,
  TOTAL_CALLABLE_UNITS:  N,
  TOTAL_API_ENDPOINTS:   N,
  TOTAL_BUSINESS_RULES:  N,
  TOTAL_DB_TABLES:       N,
  TOTAL_EVENTS:          N,
  TOTAL_INTEGRATIONS:    N,
  TOTAL_JOBS:            N,
  TOTAL_IMPORT_FILES:    N,
  DATA_GAP_ENTITY:       true,   // include ONLY if the gap condition above held
  DATA_GAP_API:          true,   // include ONLY if the gap condition above held
  DATA_GAP_SYMBOL:       true,   // include ONLY if the gap condition above held
  DATA_GAP_RULE:         true,   // include ONLY if the gap condition above held
  DATA_GAP_DB:           true,   // include ONLY if the gap condition above held
  PHASE1_GRAPH_COMPLETE: true
}

Observe: confirm edit_task_context returned success.
Decide: if confirmed → log final summary and stop.
        if failed   → retry the edit_task_context call ONCE (rate-limit backoff if 429).

Final log (MANDATORY):
"Graph resolution complete. Entities:[N] | Functions:[N] | Entry Points:[N] | Rules:[N] | DB Tables:[N] | Import-tracked files:[N]"
</step>

</steps>

<constraints>
- Do NOT read source files directly.
- Do NOT set ACTIVE_PHASE (the TypeScript orchestrator manages phase transitions).
- Do NOT write any section or report files.
- C2 MUST always run — PHASE1_GRAPH_COMPLETE=true is the phase completion signal.
- C0 is already done by TypeScript — skip it entirely.
- One tool call per graph read — do NOT attempt to read multiple graphs in one call.
</constraints>
`;

export function buildGraphPassCUserPrompt(
  legacyPath: string,
  language?:  string,
  framework?: string
): string {
  return `${buildLanguageHint(language, framework)}Synthesize architecture overview and save all G5 counters for: "${legacyPath}"

Step C0 (importedBy links + MIGRATION_ORDER) is already complete — skip it. Go directly to C1.

ReAct loop:
  C1: Read entity, api, middleware, symbol, architecture graphs ONE AT A TIME.
      Self-verify: if all graphs are empty, write synthesized_overview with a resolver warning.
      Then: append-to-knowledge-graph("architecture") with synthesized_overview.

  C2: Count each of the 9 graphs (entity, symbol, api, rule, db, event, integration, job, imports) — one read per graph.
      Gap-detect: if a graph returns exists:true but 0 real entries, add its DATA_GAP flag.
      Gap-detection covers ALL FIVE of: entity, api, symbol, rule, db — not just the first three.
      Then: save ALL counters + any DATA_GAP flags + PHASE1_GRAPH_COMPLETE=true in ONE edit_task_context call.
      Retry ONCE if the save fails.

C2 MUST run even if any graph is empty — a count of 0 is valid and expected.
PHASE1_GRAPH_COMPLETE=true signals the TypeScript orchestrator that Phase 3 is done.`;
}

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
This recovery MUST save the SAME complete set of counters Pass C saves — all 9,
including imports. Dropping any counter here re-creates the gap Pass D exists to fix.

  Graph name   | Counter key to save
  entity       | TOTAL_DATA_ENTITIES
  symbol       | TOTAL_CALLABLE_UNITS
  api          | TOTAL_API_ENDPOINTS
  rule         | TOTAL_BUSINESS_RULES  ← sum of all array lengths across all domain keys
  db           | TOTAL_DB_TABLES
  event        | TOTAL_EVENTS
  integration  | TOTAL_INTEGRATIONS
  job          | TOTAL_JOBS
  imports      | TOTAL_IMPORT_FILES

For each graph: count only REAL entries (exclude keys whose value is empty {} or []).

Gap-detection (same rule as Pass C): if read-knowledge-graph returns exists:true
for entity/api/symbol/rule/db but its real entry count is 0, also save the
matching flag — DATA_GAP_ENTITY / DATA_GAP_API / DATA_GAP_SYMBOL / DATA_GAP_RULE /
DATA_GAP_DB = true. rule and db are covered by this recovery pass exactly like
the other three — do not drop them here.

After reading all 9 graphs: save ALL 9 counters + any DATA_GAP flags +
PHASE1_GRAPH_COMPLETE=true in ONE single call to edit_task_context.

Output: "Pass D complete. Entities:[N] | Functions:[N] | Endpoints:[N] | Rules:[N] | Tables:[N] | Import-tracked:[N]"
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
Execute D1: read all 9 graphs (including imports), count real entries, save all 9
counters + any DATA_GAP flags + PHASE1_GRAPH_COMPLETE=true.
Use one edit_task_context call to save all counters at once.
Stop after D1 completes.`;
}
