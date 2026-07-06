

export interface SectionConfig {
  n: number;
  name: string;
  graph: string | null;            
  ctxKeys?: string[];              
  needsDirStructure?: boolean;     
  needsDepsTree?: boolean;         
  specificInstructions: string;    
  crossRefNote?: string;           

  
  
  
  
  
  emptyGraphIsValid: boolean;

  
  
  minContentBytes: number;
}

export const SECTION_CONFIG: SectionConfig[] = [
  {
    n: 1,
    name: 'Project Identity',
    graph: null,
    ctxKeys: ['lang-profiles', 'TOTAL_FILES', 'TOTAL_ESTIMATED_LINES', 'PRIMARY_LANGUAGE', 'MONOREPO', 'MONOREPO_TYPE', 'RUNTIME_VERSIONS'],
    emptyGraphIsValid: true,    
    minContentBytes: 300,
    specificInstructions: `Load lang-profiles and inline task context keys.
Write a comprehensive project identity section including:
  - Project name and version
    (from whichever manifest exists: package.json / composer.json / pyproject.toml /
    go.mod / pom.xml / build.gradle / Cargo.toml / Gemfile / *.csproj — do NOT assume Node.js)
  - Primary programming language and version
  - Framework and framework version
  - Architecture type \u2014 read EXACTLY from lang-profiles[0].architecture_type. Do not rephrase or remap.
  - Entry point file (main file, index, app, cmd/main.go, src/main.rs — whatever the project uses)
  - Package manager:
    Node.js → npm / yarn / pnpm | Python → pip / poetry / uv / conda |
    PHP → composer | Rust → cargo | Java/Kotlin → maven / gradle |
    Go → go mod | Ruby → bundler | .NET → nuget | C/C++ → conan / vcpkg / cmake
  - Repository type (monorepo / single project)
  - Total source files (TOTAL_FILES from context)
  - Estimated total lines of code: use TOTAL_ESTIMATED_LINES from context VERBATIM.
    Do NOT sum estimatedLines from file-index yourself — that number is computed once,
    deterministically, in code specifically so it always matches Section 4's total.
    If TOTAL_ESTIMATED_LINES is missing from context, write "not measured" (never guess).
  - All subprojects (if MONOREPO=true, list each with its language and framework)

  ANALYSIS HOST TOOLCHAIN (NOT this project's runtime — do not present it as one):
  RUNTIME_VERSIONS lists interpreter/toolchain versions detected on the MACHINE RUNNING
  THIS ANALYSIS (it may show Python/Node/Java even for a COBOL or PHP project — that only
  means those tools happen to be installed on the analysis server; it says NOTHING about
  the target codebase). Present it in its own clearly-labeled subsection, e.g.
  "### Analysis Host Toolchain (reference only — not the project's own runtime)",
  separate from the project's actual detected language/framework/version above. Never
  imply these versions belong to the analyzed project.`,
  },
  {
    n: 2,
    name: 'Architecture Overview',
    graph: 'architecture',
    emptyGraphIsValid: false,   
    minContentBytes: 500,
    specificInstructions: `Call read-knowledge-graph("architecture").

The architecture graph can hold TWO shapes in the same file — use BOTH:
  (1) "synthesized_overview" (nested object) — built by the Graph Resolver from ALL graphs.
  (2) FLAT top-level fields — type, layers, patterns, modules, entryPoint,
      communicationProtocol, frontendExists — written directly during Phase 2 from the
      app/bootstrap/main file. These are real first-hand observations; never ignore them.

PRIMARY DATA SOURCE: "synthesized_overview" if present and non-empty.
  Then MERGE IN any flat top-level fields above that add detail (e.g. an entryPoint or
  patterns the synthesis missed). Do not drop flat fields just because synthesized_overview exists.

FALLBACK ORDER if synthesized_overview is missing or empty (resolver may have hit context limit):
  1. First use the FLAT top-level architecture-graph fields — they are direct Phase 2 observations.
  2. Then supplement from entity-graph, api-graph, symbol-graph, and middleware-graph directly.
  Add this note at top: "> ℹ️ synthesized_overview was not generated — rebuilt from flat architecture fields + raw graphs."

Write a complete architecture overview including:
  - System type and overall pattern
  - All layers FOUND IN THIS PROJECT — use the actual folder names and file roles from FILE_INDEX.
    Do NOT assume Controller/Service/Repository pattern. Write what actually exists in this codebase.
  - ALL modules/domains found (one paragraph per module with entities and endpoints)
  - Cross-module dependency map (which module depends on which)
  - Communication protocol (REST/GraphQL/gRPC/WebSocket/Event-Driven/CLI/Queue)
  - Design patterns observed (Repository, DI, MVC, CQRS, Factory, Active Record, etc.)
  - Global middleware/interceptor pipeline (ordered, from synthesized_overview or middleware-graph)
  - Frontend/Backend split (if frontend exists)
  - Technology decisions observed: list the libraries and frameworks found in the project.
    Do NOT explain WHY they were chosen — you cannot know this from static code analysis.
  - Total counts: entities, endpoints, modules, callable units`,
  },
  {
    n: 3,
    name: 'Source Structure',
    graph: null,
    ctxKeys: ['file-index', 'FILE_INDEX_KEY'],
    needsDirStructure: true,
    emptyGraphIsValid: true,    
    minContentBytes: 400,
    specificInstructions: `Call getWorkspaceDirectoryStructure to get the full tree.
Load file-index from task context (key from FILE_INDEX_KEY) to get file roles.
Write a COMPLETE annotated directory tree:
  - Show every folder and file
  - Annotate each significant folder with its purpose (derived from file roles in file-index)
  - Use tree format with purpose annotations on the right:
    <source-root>/
      <folder-name>/         ← <what this folder contains and why>
        <filename>.<ext>     ← <what this specific file does>
      <folder-name>/         ← <what this folder contains and why>
  - Annotate based on ACTUAL file roles found in the file-index (do NOT invent folder names)
  - Highlight: entry points, schema/model files, config files, test directories`,
  },
  {
    n: 4,
    name: 'File Classification',
    graph: null,
    ctxKeys: ['file-index', 'FILE_INDEX_KEY'],
    emptyGraphIsValid: true,    
    minContentBytes: 400,
    specificInstructions: `Load file-index from task context (key from FILE_INDEX_KEY).
Write a complete table with ONE ROW per source file:
  | File Path | Role | Layer | Side | Est. Lines | Complexity |
  |:----------|:-----|:------|:-----|:-----------|:-----------|
  
  Role — copy the role field EXACTLY as recorded in the file-index entry.
    If role is empty or "util": write "util". Do NOT guess or invent a different role.

  Layer: HTTP / Business / Data / Infrastructure / Cross-cutting / Unknown
  Side: Backend / Frontend / Shared / Build
  Complexity — use estimatedLines from FILE_INDEX (objective value, no guessing):
    LOW    = estimatedLines < 100
    MEDIUM = estimatedLines 100–400
    HIGH   = estimatedLines > 400

Include ALL files. Do not truncate the table.
After the table: summary statistics (count per role, count per complexity tier).`,

  },
  {
    n: 5,
    name: 'Domain Models',
    graph: 'entity',
    emptyGraphIsValid: false,   
    minContentBytes: 400,
    specificInstructions: `Call read-knowledge-graph("entity").
For EVERY entity in the graph, write a complete entity specification:

### EntityName
  - **Table/Collection**: table name (and table_comment if present)
  - **Defined in**: file path(s) from files[]
  - **Fields**:
    | Field | Type | PK | FK | Nullable | Unique | Default | Length | Generated | Index | Enum Values | Constraint |
    |:------|:-----|:---|:---|:---------|:-------|:--------|:-------|:----------|:------|:------------|:-----------|
    - Include EVERY field — never truncate
    - Length: show for VARCHAR/CHAR/TEXT
    - Precision/Scale: show for DECIMAL/NUMERIC
    - Enum Values: list ALL valid values for ENUM fields (copy exactly from the schema — do NOT invent values)
    - Constraint: show the exact CHECK expression from the schema (copy it literally)
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

RAW SQL / NO-ORM HANDLING:
  If an entity has no fields[] (project uses raw SQL without ORM, or C structs, or PHP arrays):
  → Write what IS available: table name, operations observed, files where it appears.
  → Add note: "> ⚠️ Raw SQL / no ORM detected — field-level schema not available from static analysis."
  → Do NOT invent field names. Write only what was explicitly found in the code.

Include ALL entities. Do NOT truncate any field list.
Write enum values as: status: ACTIVE | INACTIVE | PENDING | DELETED`,
  },

  {
    n: 6,
    name: 'Dependencies',
    graph: null,
    ctxKeys: ['dep-raw', 'DEP_RAW_KEY'],
    needsDepsTree: true,
    emptyGraphIsValid: true,    
    minContentBytes: 150,
    specificInstructions: `Call getDependencyTree to get full dependency list.
Also load dep-raw from task context if available.
For every dependency found, write a complete table:
  | Package | Version | Category | Purpose | Migration Status |
  |:--------|:--------|:---------|:--------|:----------------|

  Category: HTTP Framework / Database ORM / Authentication / Validation /
             Testing / Logging / Queue / Cache / File / Utility / DevDependency
  Purpose: one sentence describing what this package does in the project
  Migration Status:
    ✅ Safe     — well-maintained, has modern equivalent, no breaking API changes
    ⚠️ Caution — still works but has concerns (deprecated API, security issues, slow updates)
    🔴 Breaking — requires significant migration effort (explain the specific challenge)
    ⚪ Unknown  — package from an ecosystem you cannot assess with certainty
                  (use this for obscure PHP/Java/Ruby/Go packages rather than guessing)

  IMPORTANT: Only assign ✅/⚠️/🔴 if you are certain about this package's status.
  For packages you do not recognize or cannot assess: always use ⚪ Unknown.
  Never guess or fabricate migration difficulty for unfamiliar libraries.

Include ALL packages. After table: list any packages with ⚪ Unknown status — flag for manual research.
Group by Category for readability.`,
  },
  {
    n: 7,
    name: 'Functions Master Catalog',
    graph: 'symbol',
    emptyGraphIsValid: false,   
    minContentBytes: 500,
    specificInstructions: `Call read-knowledge-graph("symbol").
Write a COMPLETE catalog of ALL callable units in the codebase.

LANGUAGE NOTE: "Callable unit" means the language-appropriate concept:
  TypeScript/JavaScript → functions, methods, arrow functions, class methods
  Python  → functions (def), class methods, async def
  PHP     → functions, class methods, static methods
  Java/Kotlin → methods, static methods, constructors
  Go      → functions, methods on structs
  Rust    → fn, impl methods, trait implementations
  C/C++   → functions, member functions
  Ruby    → def methods, class methods
  C#      → methods, async Task methods
  Use the correct terminology for what was actually found.

Table format (one row per callable unit):
  | Name | File | Signature | Return Type | Execution Model | Side Effects | Purpose | Called By | Calls |
  |:-----|:-----|:----------|:------------|:----------------|:-------------|:--------|:----------|:------|

Rules:
  - Include EVERY entry in symbol-graph — no cap, no truncation
  - Signature: exact signature from graph (params + types in language-native format)
  - Side Effects: from sideEffects[] (DB write / event emit / HTTP call / file I/O / none)
  - Called By: up to 5 callers ("..." if more); "none" for public entry points
  - Calls: up to 5 callees as "name:file" format
  - Sort: Entry Points first → Services → Repositories → Helpers
  - Group by file path with ### heading per file

After the table:
  - Execution Model column: value from executionModel field
    ("async" | "sync" | "concurrent" | "procedural" | "reactive")
  - Summary: total count, breakdown by executionModel type, total with side effects
  - Top 10 most-called units (highest calledBy count)
  - Entry points list (no callers = public API surface)

NOTE: Do NOT write pseudocode or behavior here — that is Section 8.`,
    crossRefNote: 'Do NOT write function pseudocode/behavior here — that is Section 8.',
  },
  {
    n: 8,
    name: 'Function Behaviors',
    graph: 'symbol',
    emptyGraphIsValid: false,
    minContentBytes: 500,
    specificInstructions: `Call read-knowledge-graph("symbol").
Write detailed behavioral specifications for ALL callable units. Use TWO tiers:

LANGUAGE NOTE: Use language-appropriate terminology throughout:
  "function" (Python/Go/C/Rust/PHP) | "method" (Java/C#/Ruby) | "handler" (HTTP frameworks)
  Write signatures in the language's native style (def, func, fn, public void, etc.)

TIER 1 — FULL PSEUDOCODE SPECIFICATION:
Applies to: all exported/public callables, route handlers, service methods, repository methods.
For each TIER 1 callable, write:

### callableName (file: path/to/file)
**Signature**: exact signature from the graph
**Input**: param1: Type, param2: Type  (with descriptions of what each param means)
**Output**: ReturnType  (describe what the return value represents)
**Side Effects**: from sideEffects[] (DB write / event emit / HTTP call / file I/O / none)

**Pseudocode** (from the pseudocode field in the graph — write as numbered steps):
\`\`\`
1. [step from pseudocode field]
2. [step from pseudocode field]
...
\`\`\`
If the pseudocode field is empty or missing: reconstruct from calls[] and sideEffects[].
Never leave pseudocode blank — even 2-3 steps is better than nothing.

**Error scenarios**:
  - If [condition]: throw/raise [ErrorType] → HTTP [status] (if applicable) or process exit
  - If [condition]: return [default] or log warning

**Called by**: list from calledBy[]
**Calls**: list from calls[]

---

TIER 2 — ONE-LINER TABLE:
Applies to: private/internal helpers, pure utilities, simple transformations.
| Name | File | Behavior Summary | Calls | Side Effects |
(one concise line per callable)

Tier rule:
  TIER 1 if: exported/public, OR route handler, OR has sideEffects, OR has business logic
  TIER 2 if: purely internal, no side effects, no business logic

Write ALL callables from the graph — none may be skipped entirely.

NOTE: Do NOT write the catalog table — that is Section 7. Start directly with behaviors.`,
    crossRefNote: 'Do NOT write the function table — that is Section 7.',
  },
  {
    n: 9,
    name: 'Business Rules',
    graph: 'rule',
    emptyGraphIsValid: true,    
    minContentBytes: 120,
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
    emptyGraphIsValid: true,    
    minContentBytes: 120,
    specificInstructions: `Call read-knowledge-graph("api").

IMPORTANT — The api-graph key format reveals the invocation type. Handle each type correctly:

  "GET /path" / "POST /path" etc. → HTTP REST endpoint
  "query:operationName" / "mutation:operationName" → GraphQL operation
  "command:name" / "cli:name" → CLI command
  "consumer:topic" / "worker:queue" → Queue/message consumer
  "rpc:Service.Method" / "grpc:..." → gRPC / RPC method
  "CLIENT GET /path" / "CLIENT POST /path" → Frontend API call (document separately)
  "schedule:name" / "cron:name" → Scheduled trigger (cross-ref with Section 25)

For EACH entry in api-graph, write the appropriate contract:

### [Key from graph — e.g. "POST /users" or "mutation:createUser" or "command:deploy"]
  - **Type**: HTTP REST / GraphQL / CLI / Queue Consumer / gRPC / Frontend Call
  - **Handler**: callable name → file path
  - **Auth**: resolved auth requirement (JWT / API Key / Session / None / IAM / etc.)
  - **Rate Limit**: if any
  - **Middleware/Interceptor Chain**: ordered list (from middlewareChain[])
  - **Input**:
    - For HTTP: Headers / Path Params / Query Params / Body schema
    - For CLI: positional args / flags / options
    - For Queue: message payload schema
    - For GraphQL: variables schema
  - **Output/Responses**:
    - Success: response shape
    - Validation error: error format
    - Auth error: 401/403 format (HTTP) or equivalent
    - Not found: 404 or equivalent
    - Server error: 500 or equivalent
  - **Files involved**: all files in the request/processing chain

Group by resource/domain for readability.
After all contracts: Summary Table (Type | Identifier | Auth | Handler | File).`,
  },
  {
    n: 11,
    name: 'Security & Permissions',
    graph: 'security',
    emptyGraphIsValid: true,    
    minContentBytes: 150,
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
    emptyGraphIsValid: true,    
    minContentBytes: 120,
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
    emptyGraphIsValid: true,    
    minContentBytes: 150,
    specificInstructions: `Call read-knowledge-graph("db").
For EVERY table in db-graph, write all database operations:

### tableName
  **Model file**: path
  **Repository file**: path

  **Operations** — write one row per operation found in the db-graph:
  | Type   | Fields                           | Condition                    | Called From                               |
  |:-------|:---------------------------------|:-----------------------------|:------------------------------------------|
  | SELECT | <field1>, <field2>, ...        | WHERE <column> = <value>    | <functionName> → <repositoryFile>:<line>  |
  | INSERT | <field1>, <field2>, <field3>   | —                            | <functionName> → <repositoryFile>:<line>  |
  | UPDATE | <field1>, <field2>             | WHERE <column> = <value>    | <functionName> → <repositoryFile>:<line>  |
  | DELETE | <pkField>                      | WHERE <column> = <value>    | <functionName> → <repositoryFile>:<line>  |
  | UPSERT | <field1>, <field2>             | ON CONFLICT <key>            | <functionName> → <repositoryFile>:<line>  |

  Write the ACTUAL values from the db-graph. Never copy the angle-bracket placeholders.
  Use exact function names, file paths, and conditions from the graph.

Include ALL operations for ALL tables.
Group by table. Sort: SELECT → INSERT → UPDATE → DELETE.

NOTE: Do NOT write transaction boundaries — those are in Section 22.`,
    crossRefNote: 'Do NOT write transaction boundaries — those are in Section 22.',
  },
  {
    n: 14,
    name: 'Cross-Module Call Flows',
    graph: 'call-flow',
    emptyGraphIsValid: true,    
    minContentBytes: 300,
    specificInstructions: `Call read-knowledge-graph("call-flow").
Write the complete execution trace for EACH call flow in the graph.
The Graph Resolver built these flows by tracing 5-10 key endpoints end-to-end.

For each flow:

### [Flow Name: name of the feature/use-case being traced — taken from the call-flow-graph key]
**Entry Point**: invocation type and identifier (e.g. HTTP method+path, CLI command, queue topic)

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
    emptyGraphIsValid: true,    
    minContentBytes: 120,
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
    emptyGraphIsValid: true,    
    minContentBytes: 150,
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
    emptyGraphIsValid: true,    
    minContentBytes: 150,
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
    emptyGraphIsValid: true,    
    minContentBytes: 120,
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
    emptyGraphIsValid: true,    
    minContentBytes: 80,
    specificInstructions: `Call read-knowledge-graph("state").
For EVERY stateful entity in state-graph, write a finite state machine specification:

### EntityName — State Machine
  **Status field**: fieldName
  **Defined in**: modelFile

  **All States**: list all valid states with description of what each means

  **Transition Table**:
  | From State | To State | Trigger | Triggered By (function→file) | Side Effects |
  |:-----------|:---------|:--------|:-----------------------------|:-------------|

  **State diagram (text)** — format with ACTUAL states from the graph:
  \`\`\`
  <STATE_A> ──[<trigger-event>]→ <STATE_B> ──[<trigger-event>]→ <STATE_C>
                 │                         │
        [<reject-event>]↓           [<cancel-event>]↓
              <STATE_D>                 <STATE_E>
  \`\`\`
  Use the EXACT state names from the state-graph — do NOT assume PENDING/ACTIVE/COMPLETED/REJECTED.
  Every project has different state names. Copy them exactly from the graph data.

  **Invalid transitions**: what happens if code tries to set an invalid state
  (error thrown? silently ignored? logged?)

If no state machines found: write "No explicit state machines detected.
Possible implicit states may exist — check entity status/type fields in Section 5."`,
  },
  {
    n: 20,
    name: 'Async Processing Patterns',
    graph: 'async',
    emptyGraphIsValid: true,    
    minContentBytes: 100,
    specificInstructions: `Call read-knowledge-graph("async").

IF THE ASYNC GRAPH IS EMPTY:
  This is valid for many project types. Determine which case applies:
  - PHP (synchronous by default): write "PHP executes synchronously per-request. No async patterns."
  - Java/C# with threads: write "Uses threading model (Thread/ThreadPool) rather than async/await."
  - C/C++ with pthreads: write "Uses POSIX threads / platform threads rather than coroutines."
  - Go goroutines: write "Uses goroutines and channels — not captured in async-graph schema."
  - Ruby/Python with GIL: write "Uses threading with GIL — async patterns minimal."
  - Purely synchronous script: write "Project is synchronous — no async processing detected."
  → Do NOT retry or treat this as an error. An empty async-graph on a sync project is correct.

IF THE ASYNC GRAPH HAS ENTRIES:
For EVERY entry write:

### Summary Table
  | Callable | File | Concurrency Pattern | Awaited/Blocked Operations | Parallel Ops | Fire-and-Forget |

  Pattern types:
    JS/TS: sequential-await | Promise.all | Promise.allSettled | event-driven
    Python: asyncio.gather | asyncio.wait | async for | trio/anyio
    Java: CompletableFuture | ExecutorService | reactive streams
    Go: goroutines + channels | sync.WaitGroup | select
    General: callback | streaming | queue-based | thread-pool

### Detailed Async Specifications (for complex callables)
  **callableName** (file: path)
  - Pattern: (language-appropriate term)
  - Blocking operations: what is awaited/blocked on and WHY it must be sequential
  - Concurrent operations: what runs in parallel / concurrently
  - Fire-and-forget: what is started without waiting (and risk if it fails)
  - Error handling: try/catch or equivalent coverage, unhandled rejection/exception risk

### Async/Concurrency Risks
  Fire-and-forget operations that could lose errors silently.
  Missing await/sync points where concurrent operations might not be properly joined.`,
  },
  {
    n: 21,
    name: 'Testing & Verification',
    graph: 'test',
    emptyGraphIsValid: true,    
    minContentBytes: 80,
    specificInstructions: `Call read-knowledge-graph("test").
Write complete test coverage documentation:

### Test Infrastructure
  - Framework: (Jest / Mocha / PyTest / RSpec / JUnit / etc.)
  - Config file: path
  - Test runner command: (npm test / pytest / etc.)
  - Code coverage tool: (istanbul / nyc / coverage.py / etc.)

### Test Files (one section per test file found in test-graph)
  **path/to/test-file** (use the actual file path from the graph, with the project's actual extension)
  - Covers: what module/function it tests
  - Test cases: list ALL test case names/descriptions
  - Mocks: what is mocked (libraries, services, repositories)
  - Setup/teardown: setup/teardown hooks used (beforeEach/afterEach or language equivalent)

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
    emptyGraphIsValid: true,    
    minContentBytes: 80,
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
    emptyGraphIsValid: true,    
    minContentBytes: 80,
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
    emptyGraphIsValid: true,    
    minContentBytes: 80,
    specificInstructions: `Call read-knowledge-graph("integration").
For EVERY external integration:

### Provider Name
  - **Purpose**: what this integration is used for
  - **Auth method**: API key / OAuth / IAM Role / etc.
  - **Called from**: file(s) that make calls to this provider
  - **SDK/library**: package name and version
  -   Operations table format:
  | Operation | Endpoint/Method | Input Payload | Response Shape |
  |:----------|:----------------|:--------------|:---------------|
  | <operationName> | <endpoint-or-sdk-method> | { <inputField>: <Type>, ... } | { <responseField>: <Type>, ... } |

  Write the ACTUAL operations found in the integration-graph — not assumed patterns.
  Use the exact operation names, endpoints, and data shapes from the graph.
  - **Error handling**: how API errors from this provider are handled
  - **Retry logic**: is there retry on failure?
  - **Rate limits**: any rate limit handling?
  - **Environment config keys**: which config keys control this integration`,
  },
  {
    n: 25,
    name: 'Scheduled Jobs & Workers',
    graph: 'job',
    emptyGraphIsValid: true,    
    minContentBytes: 80,
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
    graph: 'imports',
    ctxKeys: ['TOTAL_FILES', 'TOTAL_CALLABLE_UNITS', 'TOTAL_API_ENDPOINTS', 'TOTAL_BUSINESS_RULES', 'TOTAL_DATA_ENTITIES', 'TOTAL_DB_TABLES', 'TOTAL_EVENTS', 'TOTAL_INTEGRATIONS', 'TOTAL_JOBS', 'HIGH_CHURN_FILES', 'DEAD_CODE_CANDIDATES', 'PHASE1_AUDIT_WARNING', 'RUNTIME_VERSIONS', 'PRIMARY_LANGUAGE', 'MONOREPO', 'MULTI_PROJECT', 'MIGRATION_ORDER'],
    emptyGraphIsValid: true,    
    minContentBytes: 1000,
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
  Monorepo: [MONOREPO from context] — [MONOREPO_TYPE if monorepo]

  Analysis host toolchain (reference only — NOT this project's own runtime):
  RUNTIME_VERSIONS is a JSON object of interpreter/tool versions detected on the
  MACHINE RUNNING THIS ANALYSIS, not the target codebase. NEVER paste it as raw JSON.
  Render it as a clean bullet list, one tool per line, e.g.:
    - Node.js: v22.18.0
    - Python: 3.13.14
  Skip any entry whose value is "not installed". If RUNTIME_VERSIONS is missing, write
  "not measured" — do not fabricate values.

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
  ... (based on actual findings, not generic advice)

### Migration Ordering (from imports-graph)
  Load MIGRATION_ORDER from task context (computed by Graph Resolver from file dependency graph).

  IF MIGRATION_ORDER exists in context:
    Write as a numbered table (top 20 entries):
    | Priority | File | Depended on by N files | Notes |
    |:---------|:-----|:-----------------------|:------|
    Note below the table: "Migrate these files first — they are the foundation. Migrating leaf files first causes broken imports in their consumers."

  IF MIGRATION_ORDER not in context:
    Call read-knowledge-graph("imports") with limit=100
    Sort entries by importedBy[].length descending
    Write the same table from sorted results.
    If imports-graph is also empty: write "Migration ordering not available — re-run analysis with imports graph enabled."

### Per-Module Migration Difficulty (from rule-graph + integration-graph)
  Call read-knowledge-graph("rule") → for each domain, count entries where migratable=false
  Call read-knowledge-graph("integration") → list all external SDK providers

  Write a module-level difficulty table:
  | Module/Domain | Non-Auto Rules | External SDKs | Difficulty | Reason |
  |:-------------|:---------------|:--------------|:-----------|:-------|

  Difficulty scale:
    EASY    → all rules migratable:true, no deprecated SDKs, standard CRUD patterns
    MEDIUM  → 1–3 rules migratable:false OR one SDK with a known modern equivalent
    HARD    → 4+ rules migratable:false OR vendor-locked SDK OR complex state machine
    BLOCKER → pattern with NO known modern equivalent — requires human architectural decision

### Business Rules Requiring Human Review
  From rule-graph: list ALL entries where migratable=false
  | Domain | Rule | Reason Cannot Auto-Migrate | File | Recommendation |
  |:-------|:-----|:---------------------------|:-----|:---------------|

  If all rules are migratable: write "All business rules are auto-migratable to the target stack."

### External Integration Risk
  From integration-graph: list all providers
  | Provider | Current Usage | Migration Path Exists? | Risk Level |
  |:---------|:-------------|:-----------------------|:----------|

  If integration-graph empty: write "No external integrations detected."`,
  },
];

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
6. Do not skip any entry in the graph. Every entity, every callable, every endpoint.
7. EMPTY GRAPH VALIDATION — MANDATORY before writing "None detected in this codebase":
   a. Call get_task_context and read ALL counters:
      TOTAL_CALLABLE_UNITS, TOTAL_DATA_ENTITIES, TOTAL_API_ENDPOINTS,
      TOTAL_DB_TABLES, TOTAL_EVENTS, TOTAL_INTEGRATIONS, TOTAL_JOBS,
      TOTAL_BUSINESS_RULES.
      ALSO read the gap flags saved by graph resolution (Pass C/D):
      DATA_GAP_ENTITY, DATA_GAP_API, DATA_GAP_SYMBOL. If the flag for THIS
      section's graph is true, the graph was created but lost its data — write
      the DATA GAP WARNING (rule 7c) at the top of the section, even if you have
      no other signal. This is a confirmed cross-phase gap; never hide it.
   b. Cross-check the graph for THIS section against its counter:
      Graph         | Counter to check         | Threshold
      symbol-graph  | TOTAL_CALLABLE_UNITS     | > 20
      entity-graph  | TOTAL_DATA_ENTITIES      | > 5
      api-graph     | TOTAL_API_ENDPOINTS      | > 0
      db-graph      | TOTAL_DB_TABLES          | > 0
      event-graph   | TOTAL_EVENTS             | > 0
      integration   | TOTAL_INTEGRATIONS       | > 0
      job-graph     | TOTAL_JOBS               | > 0
      rule-graph    | TOTAL_BUSINESS_RULES     | > 0
   c. If the relevant graph is EMPTY and its counter is GREATER THAN 0
      (whether or not it exceeds the threshold above):
      → Write this DATA GAP WARNING at the TOP of the section:
      "> ⚠️ DATA GAP WARNING: The [graph-name] is empty, but [counter]=[N] was recorded.
      > This indicates a Phase 2 or Phase 3 analysis gap. Section content is incomplete.
      > Re-run the analysis to regenerate this graph."
      → Then write what you CAN determine from other available graphs.
      NOTE: the Threshold column is only a guide for how ALARMING the gap is
      (a count far above threshold is a severe gap). ANY non-zero counter with an
      empty graph is a DATA GAP — never silently write "None detected" in that case.
   d. If the relevant counter IS exactly the number 0:
      → The project genuinely has none of these items. Write "None detected." normally.
      → This is NOT an error — many projects have no events, no jobs, no integrations.
   e. If the relevant counter is MISSING / NOT SET (the key does not exist in task context):
      → This means Phase 3 (graph resolution) did not complete — counters were never saved.
      → Write this ANALYSIS GAP WARNING at the TOP of the section:
      "> ⚠️ ANALYSIS GAP: G5 counters were not saved (Phase 3 may not have completed).
      > The 'None detected' result below may be incorrect. Re-run the full analysis."
      → Then write "None detected (counter not set — re-run to verify)."
      → This is DIFFERENT from d above: 0 means zero, missing means unknown.
   f. For graphs with genuinely no corresponding counter (middleware/security/config/
      state/transform/error/async/test/call-flow):
      → Write "None detected in this codebase." normally.
      → NOTE: rule-graph DOES have a counter (TOTAL_BUSINESS_RULES) — it is handled by
      rules b–e above, NOT here. Never treat rule-graph as counter-less.
</rules>

<output_format>
MANDATORY HEADER — every section file MUST start with this exact format:
  ## {N}. {Section Name}
  (where {N} is the section number and {Section Name} is the section title given to you)

  Examples of correct headers:
    ## 5. Domain Models
    ## 13. Database Operations
    ## 26. Risk Scorecard & Migration Complexity

  CRITICAL: Write this header even if the section content is "None detected."
  The assembler reads every section file by filename only — it does NOT add the header for you.
  A section file without ## header will have no title in the final document.

CONTENT FORMAT RULES:
- Write the full section content immediately after the ## header (no blank line between header and content)
- Use H3 (###) for all sub-sections — never use ## inside a section file (only one ## per file)
- Use markdown tables for tabular data — include header row + alignment row on every table
- Use fenced code blocks with the correct language tag: \`\`\`json, \`\`\`sql, \`\`\`typescript, \`\`\`python, etc.
- Use \`\`\`text for plain-text diagrams (state machines, ASCII flows)
- Do NOT add a horizontal rule (---) at the end — the assembler adds separators between sections automatically
</output_format>

<stop_condition>
Stop immediately after writing the section file.
Do not write any other section. Do not set ACTIVE_PHASE.
</stop_condition>
`;

import { buildLanguageHint } from './file-analysis-prompt.js';

export function buildSectionUserPrompt(
  section:    SectionConfig,
  modernPath: string,
  language?:  string,
  framework?: string
): string {
  const sectionNum = String(section.n).padStart(2, '0');
  const outputFile = `_analysis/sections/section-${sectionNum}.md`;

  const lines: string[] = [
    buildLanguageHint(language, framework) + `Write Section ${section.n}: ${section.name}`,
    '',
  ];

  
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

export function buildParallelSectionGroups(sections: SectionConfig[]): SectionConfig[][] {
  
  const graphGroups: Map<string, SectionConfig[]> = new Map();

  for (const section of sections) {
    const key = section.graph || `_no_graph_${section.n}`;
    
    const groupKey = section.graph || `_no_graph_${section.n}`;
    if (!graphGroups.has(groupKey)) graphGroups.set(groupKey, []);
    graphGroups.get(groupKey)!.push(section);
  }

  
  
  const slots = Array.from(graphGroups.values());

  
  const PARALLEL_BATCH_SIZE = 5;
  const parallelBatches: SectionConfig[][] = [];

  
  
  
  const maxRounds = Math.max(...slots.map(s => s.length));

  for (let round = 0; round < maxRounds; round++) {
    
    const roundSections: SectionConfig[] = [];
    for (const slot of slots) {
      if (slot[round]) roundSections.push(slot[round]);
    }

    
    for (let i = 0; i < roundSections.length; i += PARALLEL_BATCH_SIZE) {
      parallelBatches.push(roundSections.slice(i, i + PARALLEL_BATCH_SIZE));
    }
  }

  return parallelBatches;
}

export const SECTION_THEME_GROUPS: Record<string, number[]> = {
  'Project Identity':         [1, 2, 3, 4, 6],              
  'Code Architecture':        [7, 8, 9, 14, 15],             
  'Data Layer':               [5, 13, 19, 22],               
  'API & Security':           [10, 11, 12, 18],              
  'Operations & Quality':     [16, 17, 20, 21, 23, 24, 25],  
  'Risk & Migration':         [26],                           
};

export function getSectionThemeName(sectionNumber: number): string {
  for (const [theme, sections] of Object.entries(SECTION_THEME_GROUPS)) {
    if (sections.includes(sectionNumber)) return theme;
  }
  return 'General';
}
