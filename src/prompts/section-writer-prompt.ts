// =============================================================================
//  section-writer-prompt.ts — Stage 4 Section Writer Agent
//
//  This file contains:
//    1. SECTION_SYSTEM_PROMPT — short generic system prompt used for all 26 sections
//    2. SECTION_CONFIG — configuration for all 26 sections (graph, instructions, exclusions)
//    3. buildSectionUserPrompt() — generates a tailored user prompt per section
//
//  Each section agent call gets:
//    system: SECTION_SYSTEM_PROMPT (short, focused, same for all 26)
//    user:   buildSectionUserPrompt(section) (tailored per section)
//
//  The agent writes to: _analysis/sections/section-NN.md
//  The TypeScript assembler later combines all 26 into Stage1_Analysis.md
// =============================================================================

// ── Section Config Type ───────────────────────────────────────────────────────

export interface SectionConfig {
  n: number;
  name: string;
  graph: string | null;            // null = no graph; use task context / other tool
  ctxKeys?: string[];              // task context keys to call get_task_context for
  needsDirStructure?: boolean;     // call getWorkspaceDirectoryStructure
  needsDepsTree?: boolean;         // call getDependencyTree
  specificInstructions: string;    // WHAT to write in this section
  crossRefNote?: string;           // what NOT to repeat (refers to other sections)
}

// ── All 26 Section Configurations ────────────────────────────────────────────

export const SECTION_CONFIG: SectionConfig[] = [
  {
    n: 1,
    name: 'Project Identity',
    graph: null,
    ctxKeys: ['lang-profiles', 'TOTAL_FILES', 'PRIMARY_LANGUAGE', 'MONOREPO', 'MONOREPO_TYPE', 'RUNTIME_VERSIONS'],
    specificInstructions: `Load lang-profiles and inline task context keys.
Write a comprehensive project identity section including:
  - Project name and version (from package.json / manifest)
  - Primary programming language and version
  - Framework and framework version
  - Architecture type (REST API, GraphQL, MVC, CLI, Worker, etc.)
  - Entry point file (main file, index, app.ts, etc.)
  - Package manager (npm, yarn, pip, cargo, maven, etc.)
  - Repository type (monorepo / single project)
  - Total source files (TOTAL_FILES from context)
  - Estimated total lines of code (sum of estimatedLines from file-index)
  - Runtime versions (from RUNTIME_VERSIONS)
  - All subprojects (if MONOREPO=true, list each with its language and framework)`,
  },
  {
    n: 2,
    name: 'Architecture Overview',
    graph: 'architecture',
    specificInstructions: `Call read-knowledge-graph("architecture").
Use the synthesized_overview key which was built by the Graph Resolver from ALL graphs.
Write a complete architecture overview including:
  - System type and overall pattern
  - All layers (HTTP/Controller/Service/Repository/Data) with their files and responsibilities
  - ALL modules/domains found (one paragraph per module with entities and endpoints)
  - Cross-module dependency map (which module depends on which)
  - Communication protocol (REST/GraphQL/gRPC/WebSocket/Event-Driven)
  - Design patterns observed (Repository, DI, MVC, CQRS, Factory, etc.)
  - Global middleware pipeline (ordered list from synthesized_overview.globalMiddlewarePipeline)
  - Frontend/Backend split (if frontend exists)
  - Technology decisions and WHY (infer from patterns)
  - Total counts: entities, endpoints, modules, callable units`,
  },
  {
    n: 3,
    name: 'Source Structure',
    graph: null,
    ctxKeys: ['file-index', 'FILE_INDEX_KEY'],
    needsDirStructure: true,
    specificInstructions: `Call getWorkspaceDirectoryStructure to get the full tree.
Load file-index from task context (key from FILE_INDEX_KEY) to get file roles.
Write a COMPLETE annotated directory tree:
  - Show every folder and file
  - Annotate each significant folder with its purpose (derived from file roles in file-index)
  - Use tree format with purpose annotations on the right:
    src/
      controllers/         ← HTTP request handlers — receives req, validates, calls service
        UserController.ts  ← User CRUD operations (createUser, getUser, updateUser, deleteUser)
      services/            ← Business logic layer — orchestrates repositories and rules
  - Highlight: entry point files, schema files, config files, test directories
  - Note any unusual structure patterns (nested monorepo, shared utilities, etc.)`,
  },
  {
    n: 4,
    name: 'File Classification',
    graph: null,
    ctxKeys: ['file-index', 'FILE_INDEX_KEY'],
    specificInstructions: `Load file-index from task context (key from FILE_INDEX_KEY).
Write a complete table with ONE ROW per source file:
  | File Path | Role | Layer | Side | Est. Lines | Complexity |
  |:----------|:-----|:------|:-----|:-----------|:-----------|
  
  Role: Controller / Service / Repository / Model / Middleware / Route / Config / 
        Migration / Schema / Helper / Utility / Auth / Event / Job / Test / DTO / Type
  Layer: HTTP / Business / Data / Infrastructure / Cross-cutting
  Side: Backend / Frontend / Shared / Build
  Complexity: LOW (simple CRUD) / MEDIUM (business logic) / HIGH (complex orchestration)

Include ALL files. Do not truncate the table. Use "..." only when role is genuinely unclear.
After the table: summary statistics (count per role, count per complexity tier).`,
  },
  {
    n: 5,
    name: 'Domain Models',
    graph: 'entity',
    specificInstructions: `Call read-knowledge-graph("entity").
For EVERY entity in the graph, write a complete entity specification:

### EntityName
  - **Table/Collection**: table name (and table_comment if present)
  - **Defined in**: file path(s) from files[]
  - **Fields**:
    | Field | Type | PK | FK | Nullable | Unique | Default | Length | Generated | Index | Enum Values | Constraint |
    |:------|:-----|:---|:---|:---------|:-------|:--------|:-------|:----------|:------|:------------|:-----------|
    - Include EVERY field \u2014 never truncate
    - Length: show for VARCHAR/CHAR/TEXT (e.g. "255")
    - Precision/Scale: show for DECIMAL/NUMERIC (e.g. "10,2")
    - Enum Values: list ALL valid values for ENUM fields (e.g. "ACTIVE | INACTIVE | PENDING")
    - Constraint: show check_constraint expression if present (e.g. "age > 0")
    - Generated: mark Y for AUTO_INCREMENT / SERIAL / @Generated fields
    - Column comment: add below the table row if the comment field is present
  - **Relationships**: (all from relations array)
    - hasMany: TargetEntity via fieldName (joinTable if many-to-many)
    - belongsTo: TargetEntity via fieldName
    - hasOne: TargetEntity via fieldName
    - manyToMany: TargetEntity via joinTable
  - **Composite Primary Key**: (list all PK fields if composite_pk is present)
  - **Composite Indexes**: (from composite_indexes array)
    - IndexName: [field1, field2, ...] — UNIQUE / NON-UNIQUE
  - **Named Constraints**: all items from constraints[] array
  - **Enums**: all enum fields with all valid values (from enums{} object)

Include ALL entities. Do NOT truncate any field list.
Write enum values as: status: ACTIVE | INACTIVE | PENDING | DELETED`,
  },

  {
    n: 6,
    name: 'Dependencies',
    graph: null,
    ctxKeys: ['dep-raw', 'DEP_RAW_KEY'],
    needsDepsTree: true,
    specificInstructions: `Call getDependencyTree to get full dependency list.
Also load dep-raw from task context if available.
For every dependency found, write a complete table:
  | Package | Version | Category | Purpose | Migration Status |
  |:--------|:--------|:---------|:--------|:----------------|
  
  Category: HTTP Framework / Database ORM / Authentication / Validation / 
             Testing / Logging / Queue / Cache / File / Utility / DevDependency
  Purpose: one sentence describing what this package does in the project
  Migration Status: 
    ✅ Safe (well-maintained, has modern equivalent, no breaking API changes)
    ⚠️ Deprecated (still works but should be replaced — explain why)
    🔴 Breaking (requires significant migration effort — explain the challenge)

Include ALL packages. After table: list any MIGRATION_GAPSs (packages with no modern equivalent).
Group by Category for readability.`,
  },
  {
    n: 7,
    name: 'Functions Master Catalog',
    graph: 'symbol',
    specificInstructions: `Call read-knowledge-graph("symbol").
Write a COMPLETE table of ALL functions/methods/handlers in the codebase:
  | Function | File | Signature | Return Type | Async | Side Effects | Purpose | Called By | Calls |
  |:---------|:-----|:----------|:------------|:------|:-------------|:--------|:----------|:------|

Rules:
  - Include EVERY entry in symbol-graph — no cap, no truncation
  - Signature: use the full signature string from the graph (e.g. "(userId: string): Promise<User>")
  - Side Effects: list each one (DB write, event emit, HTTP call, etc.) from sideEffects[] in the graph
  - Called By: list up to 5 callers (use "..." if more); use "none" for public entry points
  - Calls: list up to 5 callees with file paths in "funcName:file" format (use "..." if more)
  - Sort by: Entry Points first (no callers), then Services, then Repositories, then Helpers
  - Group by file path for readability with a ### heading per file

After the table:
  - Summary: total function count, total async count, total with side effects
  - Top 10 most-called functions (highest calledBy count)
  - Entry points list (functions with no callers = public API surface)

NOTE: Do NOT write pseudocode or behavior descriptions here — that is Section 8.`,
    crossRefNote: 'Do NOT write function pseudocode/behavior here — that is Section 8.',
  },
  {
    n: 8,
    name: 'Function Behaviors',
    graph: 'symbol',
    specificInstructions: `Call read-knowledge-graph("symbol").
Write detailed behavioral specifications for ALL functions. Use TWO tiers:

TIER 1 — FULL PSEUDOCODE SPECIFICATION:
Applies to: all exported functions, route handlers, service methods, repository methods.
For each TIER 1 function, write:

### functionName (file: path/to/file.ts)
**Signature**: exact signature from the graph
**Input**: param1: Type, param2: Type  (with descriptions of what each param means)
**Output**: ReturnType  (describe what the return value represents)
**Side Effects**: list from sideEffects[] field in the graph (DB write / event emit / HTTP call / none)

**Pseudocode** (from the pseudocode field in the graph — write it exactly as numbered steps):
\`\`\`
1. [step from pseudocode field]
2. [step from pseudocode field]
...
\`\`\`
If the pseudocode field is empty or missing for a function, reconstruct it by reading
the function's calls[] list and sideEffects[] to infer the steps. Never leave it blank.

**Error scenarios**:
  List every error case from the pseudocode steps:
  - If [condition]: throw [ErrorType]("[message]") → HTTP [status] (if applicable)
  - If [condition]: return [default] or log warning

**Called by**: list from calledBy[] in the graph
**Calls**: list from calls[] in the graph

---

TIER 2 — ONE-LINER TABLE:
Applies to: private helper functions, internal utilities, pure transformation functions.
| Function | File | Behavior Summary | Calls | Side Effects |
(one concise line per function describing what it does)

Tier classification rule:
  TIER 1 if: function is exported, OR is a route handler, OR has any sideEffects, OR has business logic
  TIER 2 if: purely internal private helper with no side effects and no business logic

Write ALL functions from the graph — no function may be skipped entirely.

NOTE: Do NOT write the function catalog table — that is Section 7. Start directly with behaviors.`,
    crossRefNote: 'Do NOT write the function table — that is Section 7.',
  },
  {
    n: 9,
    name: 'Business Rules',
    graph: 'rule',
    specificInstructions: `Call read-knowledge-graph("rule").
Write ALL business rules found across ALL domains EXCEPT the "validation" domain
(validation rules are documented separately in Section 18).

Group rules by domain. For each domain, list every rule:

### [Domain Name] (e.g., Authentication, Authorization, Pricing, Order Processing)
  **Rule**: [exact rule description]
  **Enforced in**: [file:function]
  **Violation response**: [what happens — error thrown, redirect, status code]
  **Related files**: [list of files where this rule applies]

Include EVERY rule from every domain except "validation".
Do NOT use generic descriptions — write the ACTUAL business rule found in the code.`,
    crossRefNote: 'Do NOT write validation rules — those are in Section 18 (rule-graph "validation" domain).',
  },
  {
    n: 10,
    name: 'API Contracts',
    graph: 'api',
    specificInstructions: `Call read-knowledge-graph("api").
For EVERY endpoint in api-graph, write a complete API contract:

### METHOD /path
  - **Handler**: function name → file path
  - **Auth**: resolved auth requirement (JWT Bearer / API Key / None / etc.)
  - **Rate Limit**: if any
  - **Middleware Chain**: ordered list (from middlewareChain array)
  - **Request**:
    - Headers: (required headers)
    - Path Params: (if any)
    - Query Params: (if any)
    - Body: (full schema with field names, types, required/optional)
  - **Responses**:
    - 200/201: success response schema
    - 400: validation error format
    - 401: unauthorized format
    - 403: forbidden format
    - 404: not found format
    - 500: server error format
  - **Files involved**: all files in the request chain

Include ALL endpoints. Group by resource/domain for readability.
After all contracts: API Summary Table (Method | Path | Auth | Handler | Status).`,
  },
  {
    n: 11,
    name: 'Security & Permissions',
    graph: 'security',
    specificInstructions: `Call read-knowledge-graph("security").
Write a complete security documentation:

### Authentication Mechanism
  What type (JWT/Session/API Key/OAuth/Basic/None) and how it works.

### Token Strategy
  - Generation: how tokens are created, what library/algorithm
  - Validation: how tokens are verified, where validation happens
  - Expiry: access token TTL, refresh token TTL
  - Storage: where tokens are stored (header/cookie/body)
  - Algorithm: (e.g., HS256, RS256)
  - Secret management: env variable name

### Role-Based Access Control
  For each role: what endpoints it can access, what operations it can perform.
  | Role | Permissions | Restricted From |

### Route Classification
  **Public routes** (no auth): list all
  **Protected routes**: authentication required — list all with required role
  **Admin-only routes**: list all

### Security Patterns
  CORS configuration, CSRF protection, input sanitization, rate limiting.`,
  },
  {
    n: 12,
    name: 'Middleware Execution Order',
    graph: 'middleware',
    specificInstructions: `Call read-knowledge-graph("middleware").
Write the complete middleware documentation:

### Global Middleware Pipeline (ordered)
  Every request passes through this chain in order:
  1. [order:1] middlewareName → file:path — Purpose: what it does
  2. [order:2] middlewareName → file:path — Purpose: what it does
  ... (all from globalPipeline sorted by order field)

### Route-Specific Middleware
  For routes that have ADDITIONAL middleware beyond the global pipeline:
  - **ROUTE**: middleware1, middleware2 (in order)

### Middleware Specifications
  For each middleware function:
  **middlewareName** (file: path)
    - Applies to: global / route-specific / error handler
    - What it does: detailed description
    - Modifies req/res: what it adds/changes
    - When it calls next(): conditions
    - When it short-circuits: (returns early without calling next)

  Registration file: [where middleware is registered in app.ts/index.ts]`,
    crossRefNote: 'Do NOT repeat auth mechanism details — those are in Section 11 (Security).',
  },
  {
    n: 13,
    name: 'Database Operations',
    graph: 'db',
    specificInstructions: `Call read-knowledge-graph("db").
For EVERY table in db-graph, write all database operations:

### tableName
  **Model file**: path
  **Repository file**: path

  **Operations**:
  | Type | Fields | Condition | Called From (function → file) |
  |:-----|:-------|:----------|:------------------------------|
  | SELECT | field1, field2 | WHERE id = ? | findById → UserRepository.ts:45 |
  | INSERT | field1, field2, field3 | — | create → UserRepository.ts:67 |
  | UPDATE | field1, field2 | WHERE id = ? | update → UserRepository.ts:89 |
  | DELETE | — | WHERE id = ? | softDelete → UserRepository.ts:110 |

Include ALL operations for ALL tables.
Group by table. Sort: SELECT → INSERT → UPDATE → DELETE.

NOTE: Do NOT write transaction boundaries — those are in Section 22.`,
    crossRefNote: 'Do NOT write transaction boundaries — those are in Section 22.',
  },
  {
    n: 14,
    name: 'Cross-Module Call Flows',
    graph: 'call-flow',
    specificInstructions: `Call read-knowledge-graph("call-flow").
Write the complete execution trace for EACH call flow in the graph.
The Graph Resolver built these flows by tracing 5-10 key endpoints end-to-end.

For each flow:

### [Flow Name: e.g., "User Registration", "Product Order Creation"]
**Entry Point**: METHOD /path

\`\`\`
Step 1:  [layer] description → file:line
Step 2:  [layer] description → file:line
...
Step N:  [layer] description → file:line
\`\`\`

**Data flow summary**:
  Input: what enters the system
  Transformations: how data changes at each step
  Output: what leaves the system

**Error paths**: what happens when each step fails

Write ALL flows from call-flow-graph. If only 5-10 flows exist, explain why those were chosen.`,
  },
  {
    n: 15,
    name: 'Data Transformations',
    graph: 'transform',
    specificInstructions: `Call read-knowledge-graph("transform").
For EVERY transformation in the graph, write:

### Transformation Name
  - **Input**: file path → data shape
    \`\`\`json
    { field1: Type, field2: Type, ... }
    \`\`\`
  - **Transform function**: functionName → file:path
  - **Output**: file path → data shape
    \`\`\`json
    { field1: Type, field2: Type, ... }
    \`\`\`
  - **Excluded fields**: list of fields that are removed/not mapped
  - **Added fields**: list of fields computed during transformation

Common transformation types to document:
  - DTO → Entity (input validation + mapping)
  - Entity → Response DTO (serialization, field exclusion)
  - External API response → internal model
  - Database record → domain object

Include ALL transformations. If graph is empty: write "No explicit transformations documented."`,
  },
  {
    n: 16,
    name: 'Configuration & Environment',
    graph: 'config',
    specificInstructions: `Call read-knowledge-graph("config").
For EVERY configuration key in the graph:

### Config Key Table
  | Config Key | Type | Required | Default | Purpose | Used In |
  |:-----------|:-----|:---------|:--------|:--------|:--------|

After the table, write configuration categories:

### Database Configuration
  (all DB connection keys — host, port, name, user, password, pool)

### Authentication Configuration
  (JWT secret, expiry, algorithm, etc.)

### External Services Configuration
  (API keys, URLs, credentials for third-party services)

### Application Configuration
  (port, environment, log level, feature flags)

### Security Configuration
  (CORS origins, rate limits, CSRF settings)

Include ALL config keys. Do NOT redact or hide any key names (values are empty — we're documenting the key names).`,
  },
  {
    n: 17,
    name: 'Error Handling Patterns',
    graph: 'error',
    specificInstructions: `Call read-knowledge-graph("error").
Write complete error handling documentation:

### Custom Error Classes
  For EVERY custom error in error-graph:
  **ErrorClassName** (defined in: file path)
    - Extends: parent error class
    - HTTP Status: status code
    - Message format: how the message is constructed
    - Thrown in: ALL files/functions that throw this error

### Global Error Handler
  - File: path
  - Behavior: what it does with caught errors
  - Response format: JSON structure of error responses
  - Logging behavior: what gets logged, at what level
  - Differentiates: operational vs programming errors (yes/no)

### Error Flow
  How an error thrown in a repository propagates to the HTTP response:
  throw ErrorType → (caught by?) → (transformed to?) → HTTP response shape

### Unhandled Rejections / Uncaught Exceptions
  What happens if an async operation rejects without a catch block.`,
  },
  {
    n: 18,
    name: 'Validation Rules',
    graph: 'rule',
    specificInstructions: `Call read-knowledge-graph("rule").
Write ONLY the rules from the "validation" domain.
(Other business rules from other domains are in Section 9.)

Group validation rules by what they validate:

### Input/Request Validation
  For each validation rule applied to incoming request data:
  - **Field**: field name
  - **Rules applied**: required | minLength:N | maxLength:N | pattern:regex | enum:[values] | custom
  - **Error message**: what error is returned on failure
  - **Enforced in**: file:function

### Entity/Model Validation
  Validations applied at the model/ORM level (before DB write):
  - Field-level constraints, not-null rules, uniqueness validation

### Business Validation
  Cross-field or cross-entity validations:
  (e.g., "end date must be after start date", "user cannot have more than 5 active orders")

Include EVERY validation rule found.`,
    crossRefNote: 'Write ONLY "validation" domain rules. Other business rules are in Section 9.',
  },
  {
    n: 19,
    name: 'State Transitions',
    graph: 'state',
    specificInstructions: `Call read-knowledge-graph("state").
For EVERY stateful entity in state-graph, write a finite state machine specification:

### EntityName — State Machine
  **Status field**: fieldName
  **Defined in**: modelFile

  **All States**: list all valid states with description of what each means

  **Transition Table**:
  | From State | To State | Trigger | Triggered By (function→file) | Side Effects |
  |:-----------|:---------|:--------|:-----------------------------|:-------------|

  **State diagram (text)**:
  \`\`\`
  PENDING ──[approve]-→ ACTIVE ──[complete]-→ COMPLETED
                 │                    │
          [reject]↓             [cancel]↓
               REJECTED           CANCELLED
  \`\`\`

  **Invalid transitions**: what happens if code tries to set an invalid state
  (error thrown? silently ignored? logged?)

If no state machines found: write "No explicit state machines detected.
Possible implicit states may exist — check entity status/type fields in Section 5."`,
  },
  {
    n: 20,
    name: 'Async Processing Patterns',
    graph: 'async',
    specificInstructions: `Call read-knowledge-graph("async").
For EVERY async function in the async-graph:

### Summary Table
  | Function | File | Pattern | Awaited Operations | Parallel Ops | Fire-and-Forget |
  
  Pattern types: sequential-await | Promise.all | Promise.allSettled | 
                 event-driven | queue-based | callback | streaming

### Detailed Async Specifications (for complex functions)
  **functionName** (file: path)
  - Pattern: sequential-await / parallel / mixed
  - Awaited calls (blocking): list what is awaited and WHY it must be sequential
  - Parallel operations: what runs in Promise.all / concurrently
  - Fire-and-forget: what is called without await (and risk if it fails)
  - Error handling: try/catch coverage, unhandled rejection risk

### Async Risks
  List any fire-and-forget operations that could lose errors silently.
  List any missing await keywords detected (where async operations might not be awaited).`,
  },
  {
    n: 21,
    name: 'Testing & Verification',
    graph: 'test',
    specificInstructions: `Call read-knowledge-graph("test").
Write complete test coverage documentation:

### Test Infrastructure
  - Framework: (Jest / Mocha / PyTest / RSpec / JUnit / etc.)
  - Config file: path
  - Test runner command: (npm test / pytest / etc.)
  - Code coverage tool: (istanbul / nyc / coverage.py / etc.)

### Test Files (one section per test file)
  **path/to/test-file.spec.ts**
  - Covers: what module/function it tests
  - Test cases: list ALL test case names/descriptions
  - Mocks: what is mocked (libraries, services, repositories)
  - Setup/teardown: beforeEach/afterEach patterns

### Coverage Summary
  - Total test files: N
  - Files with tests: N / TOTAL_FILES
  - Untested files: list files with no corresponding test

### Testing Gaps
  What is NOT tested (based on files in file-index that have no corresponding test entry).`,
  },
  {
    n: 22,
    name: 'Transaction Boundaries',
    graph: 'db',
    specificInstructions: `Call read-knowledge-graph("db").
Write ONLY the transaction boundary documentation.
(Individual DB operations are in Section 13 — do NOT repeat them here.)

A transaction boundary is where multiple DB operations must succeed or fail TOGETHER.

### Transaction Specifications
  For each transaction found in db-graph:
  **Transaction Name / Use Case**
    - Started in: function → file
    - Operations inside:
      1. Operation 1 (table, type, description)
      2. Operation 2 (table, type, description)
    - Commit condition: when all succeed
    - Rollback condition: what triggers rollback
    - Isolation level: (READ_COMMITTED / REPEATABLE_READ / SERIALIZABLE / default)
    - Nested transactions: (if any)

If no explicit transactions found:
  Write "No explicit transaction management detected. Operations may not be atomic."
  List the multi-step operations that SHOULD be in transactions (but aren't).`,
    crossRefNote: 'Write ONLY transaction boundaries. Individual DB operations are in Section 13.',
  },
  {
    n: 23,
    name: 'Event Flows',
    graph: 'event',
    specificInstructions: `Call read-knowledge-graph("event").
For EVERY event in the event-graph:

### event.name
  - **Emitted in**: file:function
  - **When emitted**: the condition/trigger (e.g., "after successful user creation")
  - **Payload**:
    \`\`\`json
    { field1: Type, field2: Type, ... }
    \`\`\`
  - **Listeners**:
    | File | Handler Function | What It Does |
  - **Registered in**: registrationFile
  - **Error handling**: what happens if a listener throws

### Event System Architecture
  - Event library/system used (EventEmitter, Bull, RabbitMQ, Kafka, etc.)
  - Total events: N
  - Total listeners: N
  - Any unhandled events (emitted but no listeners found)?`,
  },
  {
    n: 24,
    name: 'External Integrations',
    graph: 'integration',
    specificInstructions: `Call read-knowledge-graph("integration").
For EVERY external integration:

### Provider Name (e.g., Stripe, SendGrid, AWS S3, Twilio)
  - **Purpose**: what this integration is used for
  - **Auth method**: API key / OAuth / IAM Role / etc.
  - **Called from**: file(s) that make calls to this provider
  - **SDK/library**: package name and version
  - **Operations**:
    | Operation | Endpoint/Method | Sends | Receives |
    | createPayment | POST /charges | { amount, currency, source } | { id, status } |
  - **Error handling**: how API errors from this provider are handled
  - **Retry logic**: is there retry on failure?
  - **Rate limits**: any rate limit handling?
  - **Environment config keys**: which config keys control this integration`,
  },
  {
    n: 25,
    name: 'Scheduled Jobs & Workers',
    graph: 'job',
    specificInstructions: `Call read-knowledge-graph("job").
For EVERY scheduled job or background worker:

### Job Name
  - **Type**: cron / queue worker / interval / one-shot
  - **Schedule**: cron expression OR interval in human-readable form
    (e.g., "Every day at 2:00 AM UTC" for "0 2 * * *")
  - **Scheduled/registered in**: file path
  - **Implementation**: function name → file path
  - **What it does**: detailed description of the job's actions
  - **Operations called**: what functions/services it uses
  - **Side effects**: DB writes, emails sent, files created, events emitted
  - **Failure handling**: retry policy, dead letter queue, alert mechanism
  - **Idempotent**: yes / no / conditional (explain)

### Worker Infrastructure
  - Queue library: (Bull / BullMQ / Celery / Sidekiq / etc.)
  - Queue backend: (Redis / RabbitMQ / SQS / etc.)
  - Concurrency: number of parallel workers`,
  },
  {
    n: 26,
    name: 'Risk Scorecard & Migration Complexity',
    graph: null,
    ctxKeys: ['TOTAL_FILES', 'TOTAL_CALLABLE_UNITS', 'TOTAL_API_ENDPOINTS', 'TOTAL_BUSINESS_RULES', 'TOTAL_DATA_ENTITIES', 'TOTAL_DB_TABLES', 'TOTAL_EVENTS', 'TOTAL_INTEGRATIONS', 'TOTAL_JOBS', 'HIGH_CHURN_FILES', 'DEAD_CODE_CANDIDATES', 'PHASE1_AUDIT_WARNING', 'RUNTIME_VERSIONS', 'PRIMARY_LANGUAGE', 'MONOREPO', 'MULTI_PROJECT'],
    specificInstructions: `Load all counters from task context via get_task_context.
Write a comprehensive risk scorecard for migration planning:

### Codebase Size Metrics
  | Metric | Value | Risk Threshold | Risk Level |
  |:-------|:------|:---------------|:-----------|
  | Total source files | [TOTAL_FILES] | LOW:<20 MED:20-100 HIGH:100+ | [assess] |
  | Total callable units | [TOTAL_CALLABLE_UNITS] | LOW:<50 MED:50-300 HIGH:300+ | [assess] |
  | Total API endpoints | [TOTAL_API_ENDPOINTS] | LOW:<10 MED:10-50 HIGH:50+ | [assess] |
  | Total business rules | [TOTAL_BUSINESS_RULES] | LOW:<20 MED:20-100 HIGH:100+ | [assess] |
  | Total data entities | [TOTAL_DATA_ENTITIES] | LOW:<10 MED:10-30 HIGH:30+ | [assess] |
  | Total DB tables | [TOTAL_DB_TABLES] | LOW:<10 MED:10-30 HIGH:30+ | [assess] |
  | Total events | [TOTAL_EVENTS] | LOW:<5 MED:5-20 HIGH:20+ | [assess] |
  | Total integrations | [TOTAL_INTEGRATIONS] | LOW:<3 MED:3-10 HIGH:10+ | [assess] |
  | Total scheduled jobs | [TOTAL_JOBS] | LOW:<5 MED:5-15 HIGH:15+ | [assess] |

  If any counter is 0 (not just missing): write the actual value 0, not "unknown".
  If a counter is undefined/missing from context: write "not measured".

### Language & Runtime
  Primary language: [PRIMARY_LANGUAGE from context]
  Runtime versions: [RUNTIME_VERSIONS from context]
  Monorepo: [MONOREPO from context] — [MONOREPO_TYPE if monorepo]

### High-Churn Files (Migration Risk)
  Files with highest commit frequency = most actively changed = highest breakage risk.
  These files must be migrated last, with the most careful review:
  (list from HIGH_CHURN_FILES in task context — list ALL of them, not just top 3)

### Dead Code Candidates
  Files with zero commits in the past year = low business value = consider removing instead of migrating:
  (list from DEAD_CODE_CANDIDATES in task context)
  If empty: write "No dead code candidates detected (all files have recent commits)."

### Overall Complexity Classification
  Calculate from metrics above:
  SIMPLE:  TOTAL_FILES < 20  AND TOTAL_CALLABLE_UNITS < 50  AND TOTAL_API_ENDPOINTS < 10
  MEDIUM:  TOTAL_FILES < 100 AND TOTAL_CALLABLE_UNITS < 300 AND TOTAL_API_ENDPOINTS < 50
  COMPLEX: TOTAL_FILES < 300 AND TOTAL_CALLABLE_UNITS < 800 AND TOTAL_API_ENDPOINTS < 100
  EXTREME: anything above COMPLEX thresholds

  OVERALL COMPLEXITY: [one of SIMPLE / MEDIUM / COMPLEX / EXTREME]
  Justification: [explain which metrics drove the classification]

### Migration Effort Estimate
  Effort tiers: XS (< 1 day) | S (1-3 days) | M (1-2 weeks) | L (2-4 weeks) | XL (1+ months)

  | Component | What Needs Migration | Estimated Effort | Key Risk |
  |:----------|:---------------------|:----------------|:---------|
  | Data model migration | [TOTAL_DATA_ENTITIES] entities, [TOTAL_DB_TABLES] tables | [tier] | [specific risk] |
  | API contract migration | [TOTAL_API_ENDPOINTS] endpoints | [tier] | [specific risk] |
  | Business rules migration | [TOTAL_BUSINESS_RULES] rules across all domains | [tier] | [specific risk] |
  | Auth/security migration | auth mechanism from Section 11 | [tier] | [specific risk] |
  | Event system migration | [TOTAL_EVENTS] events | [tier] | [specific risk] |
  | External integrations | [TOTAL_INTEGRATIONS] third-party providers | [tier] | [specific risk] |
  | Test migration | test files from Section 21 | [tier] | [specific risk] |
  | Scheduled jobs | [TOTAL_JOBS] jobs/workers | [tier] | [specific risk] |
  | Frontend (if any) | frontend components from Section 7 | [tier or "N/A"] | [specific risk] |

### Top 5 Migration Risks
  1. [Specific risk identified from analysis]
  2. [Specific risk identified from analysis]
  ... (based on actual findings, not generic advice)`,
  },
];

// ── System Prompt (same for all 26 sections) ──────────────────────────────────

export const SECTION_SYSTEM_PROMPT = `
<role>
You are a technical documentation writer producing a migration reference document.
You write exactly one section per call. Each section is sourced from structured knowledge graphs
built by the analysis pipeline. Your output is for engineers who will migrate this codebase.
</role>

<task>
Write the section specified in your user prompt.
Load the data sources listed in the user prompt. Write comprehensive markdown content.
Save the result to the output file path given. Then stop.
</task>

<rules>
1. Write EVERYTHING found in the data. Do not truncate tables, lists, or descriptions.
2. Write ONLY what was actually found. Do not invent, infer, or guess any values.
3. If a graph or data source is empty: see Rule 7 BEFORE writing "None detected."
4. Use proper markdown: headers, tables, fenced code blocks, bullet lists.
5. Be comprehensive — this document is used for code migration planning.
6. Do not skip any entry in the graph. Every entity, every function, every endpoint.
7. EMPTY GRAPH VALIDATION — MANDATORY before writing "None detected in this codebase":
   a. Call get_task_context and read: TOTAL_CALLABLE_UNITS, TOTAL_DATA_ENTITIES, TOTAL_API_ENDPOINTS.
   b. Cross-check:
      - If this section uses symbol-graph AND it's empty AND TOTAL_CALLABLE_UNITS > 20:
        → Write this warning at the TOP of the section:
        "> ⚠️ DATA GAP WARNING: The symbol graph is empty, but [N] callable units were counted.
        > This indicates a Phase 2 analysis gap. Section content may be incomplete."
        → Then write "None detected — see warning above." as the section body.
      - If this section uses entity-graph AND it's empty AND TOTAL_DATA_ENTITIES > 5:
        → Same warning pattern for entity data.
      - If this section uses api-graph AND it's empty AND TOTAL_API_ENDPOINTS > 0:
        → Same warning pattern for API data.
      - If TOTAL_CALLABLE_UNITS = 0 OR counters are not set: write "None detected." normally.
        A project genuinely may have no items in a specific graph even if other graphs are populated.
   c. For sections using graphs OTHER than symbol/entity/api (rule/middleware/db/etc.):
      Write "None detected in this codebase." normally — these graphs are optional.
</rules>


<output_format>
- Start the file with the section header: ## N. Section Name
- Write the full section content after the header
- Use H3 (###) for sub-sections within the section
- Use tables where the data is tabular
- Use fenced code blocks with the appropriate language tag for code/schemas
</output_format>

<stop_condition>
Stop immediately after writing the section file.
Do not write any other section. Do not set ACTIVE_PHASE.
</stop_condition>
`;


// ── User Prompt Builder ───────────────────────────────────────────────────────

export function buildSectionUserPrompt(section: SectionConfig, modernPath: string): string {
  const sectionNum = String(section.n).padStart(2, '0');
  const outputFile = `_analysis/sections/section-${sectionNum}.md`;

  const lines: string[] = [
    `Write Section ${section.n}: ${section.name}`,
    '',
  ];

  // Data loading instructions
  if (section.graph) {
    lines.push(`DATA SOURCE: Call read-knowledge-graph("${section.graph}") to load the data.`);
  }
  if (section.ctxKeys && section.ctxKeys.length > 0) {
    lines.push(`ALSO LOAD from task context (call get_task_context): ${section.ctxKeys.join(', ')}`);
  }
  if (section.needsDirStructure) {
    lines.push('ALSO CALL: getWorkspaceDirectoryStructure to get the directory tree.');
  }
  if (section.needsDepsTree) {
    lines.push('ALSO CALL: getDependencyTree to get all package dependencies.');
  }

  lines.push('');
  lines.push('INSTRUCTIONS:');
  lines.push(section.specificInstructions);

  if (section.crossRefNote) {
    lines.push('');
    lines.push(`IMPORTANT: ${section.crossRefNote}`);
  }

  lines.push('');
  lines.push(`OUTPUT FILE: Write the section content to: ${outputFile}`);
  lines.push('Start the file with the section header: ## ' + section.n + '. ' + section.name);
  lines.push('STOP after writing the file. Do not write other sections.');

  return lines.join('\n');
}

// ── Parallel Section Groups ────────────────────────────────────────────────────
// Sections are grouped so sections sharing the same graph run sequentially
// within a group, while groups with different graphs run in parallel.

export function buildParallelSectionGroups(sections: SectionConfig[]): SectionConfig[][] {
  // Group sections by their graph (sections sharing a graph must be sequential)
  const graphGroups: Map<string, SectionConfig[]> = new Map();

  for (const section of sections) {
    const key = section.graph || `_no_graph_${section.n}`;
    // Sections with no graph each get their own group (they only read task context, safe to parallel)
    const groupKey = section.graph || `_no_graph_${section.n}`;
    if (!graphGroups.has(groupKey)) graphGroups.set(groupKey, []);
    graphGroups.get(groupKey)!.push(section);
  }

  // Each graph group becomes one sequential "slot"
  // Multiple slots run in parallel (batches of 5 to respect rate limits)
  const slots = Array.from(graphGroups.values());

  // Pack slots into batches of 5 parallel groups
  const PARALLEL_BATCH_SIZE = 5;
  const parallelBatches: SectionConfig[][] = [];

  // Flatten into rounds: round = up to PARALLEL_BATCH_SIZE sections (one per unique graph group)
  // For groups with multiple sections (e.g., symbol has 7 and 8), those run in sequence
  // Across groups: parallel
  const maxRounds = Math.max(...slots.map(s => s.length));

  for (let round = 0; round < maxRounds; round++) {
    // Get one section from each group for this round (if that group has a section for this round)
    const roundSections: SectionConfig[] = [];
    for (const slot of slots) {
      if (slot[round]) roundSections.push(slot[round]);
    }

    // Batch into groups of PARALLEL_BATCH_SIZE
    for (let i = 0; i < roundSections.length; i += PARALLEL_BATCH_SIZE) {
      parallelBatches.push(roundSections.slice(i, i + PARALLEL_BATCH_SIZE));
    }
  }

  return parallelBatches;
}
