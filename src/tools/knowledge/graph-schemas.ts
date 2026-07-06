// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL KNOWLEDGE-GRAPH SCHEMAS — single source of truth.
//
// Every place that describes a graph's shape derives from this file:
//   • the append-to-knowledge-graph tool description  (what the LLM sees at call time)
//   • FILE_ANALYSIS_SYSTEM_PROMPT's <graph_shapes>    (what the LLM sees in its instructions)
//   • section-writer instructions                      (what field names sections read)
//
// NEVER hand-copy a field name into a prompt or tool description. A field that
// exists in two hand-written places WILL drift (it already did: the tool said
// "isAsync"/"publicRoutes" while the prompt said "executionModel"/"publicEntryPoints",
// silently losing data for Sections 7/8/11). Import from here instead.
// ─────────────────────────────────────────────────────────────────────────────

// Full, detailed shape documentation (interpolated into FILE_ANALYSIS_SYSTEM_PROMPT).
export const GRAPH_SHAPES_DOC = `
entity-graph:
  { "EntityName": {
      table: str,                  // DB table or collection name
      files: [path],               // all files that define this entity
      fields: [{
        name: str,
        type: str,
        pk: bool,
        fk: str_or_null,           // target entity name if foreign key
        nullable: bool,
        unique: bool,
        default: any,
        index: bool,
        length: num_or_null,       // e.g. 255 for VARCHAR(255)
        precision: num_or_null,    // for DECIMAL/NUMERIC
        scale: num_or_null,
        enum_values: [str],        // ALL valid enum values if ENUM field
        check_constraint: str,     // exact CHECK expression
        generated: bool,           // AUTO_INCREMENT / SERIAL / @Generated
        comment: str               // column comment/annotation description
      }],
      relations: [{type, target, fk, joinTable}],
      constraints: [str],          // named constraints
      composite_pk: [str],         // field names if composite primary key
      composite_indexes: [{name, fields:[str], unique:bool}],
      table_comment: str,
      enums: {}
  } }

symbol-graph:
  { "funcName": {
      file: str,
      signature: str,              // full signature with all params and types
      returnType: str,
      executionModel: str,       // "async" | "sync" | "concurrent" | "procedural" | "reactive"
      purpose: str,                // one sentence: WHAT it does
      pseudocode: str,             // numbered steps: HOW it does it
                                   // "1. Validate...\\n2. Check auth...\\n3. Call repo..."
      calledBy: [str],
      calls: [str],                // "funcName:path/to/file" format
      sideEffects: [str]           // ["DB write", "event emit", "HTTP call", ...]
  } }

rule-graph:
  { "domain": [{
      rule:         str,   // one sentence: exactly what this rule enforces
      type:         str,   // "validation" | "authorization" | "calculation" | "state-transition" | "rate-limit"
      enforcement:  str,   // "functionName:file/path" — where exactly it is enforced
      violation:    str,   // what happens on violation: "throw ForbiddenError → HTTP 403" or "return false"
      pseudocode:   [str], // the rule logic as steps: ["1. Check X", "2. IF Y: throw Z"]
      relatedFiles: [str], // all files referencing this rule
      migratable:   bool   // true = can auto-generate in target stack | false = needs human decision
    }]
  }

api-graph:
  { "METHOD /actual/path": {
      handler:        str,   // exact function/method name that handles this entry point
      auth:           str,   // middleware/guard/decorator name enforcing auth, or "" if none
      request: {
        body:         {},    // body fields: { fieldName: { type, required, description } }
        query:        {},    // query param fields
        path:         {}     // path param fields (e.g. :id, {userId})
      },
      responses: {
        "200":        {},    // success response shape
        "400":        {},    // validation error shape
        "401":        {},    // auth error shape
        "404":        {}     // not found shape — add others as found in the code
      },
      middlewareChain: [str], // ordered list of middleware/guards/filters applied
      files:           [str]  // all files that contribute to this entry point
  } }

db-graph:
  { "table_or_collection_name": {
      operations: [{
        type:         str,   // "find" | "findOne" | "create" | "update" | "delete" | "upsert" | "count" | "raw"
        fields:       [str], // fields read or written in this operation
        condition:    str,   // filter/WHERE expression — exact as it appears in code
        function:     str,   // name of the function that performs this operation
        calledFrom:   [str]  // file paths that call this function
      }],
      repositoryFile: str,   // file that owns the data access layer for this table/collection
      modelFile:      str    // file that defines the schema/model/entity for this table/collection
  } }

event-graph:
  { "event.name": { emittedIn:"", payload:{}, listeners:[{file,handler,does}],
    registrationFile:"" } }

config-graph:
  { "CONFIG_KEY": { type:"", required:bool, default:"", purpose:"", usedIn:[path] } }

state-graph:
  { "EntityName": { field:"", modelFile:"", states:[str],
    transitions:[{from,to,trigger,triggeredBy,sideEffects:[]}] } }

middleware-graph:
  { globalPipeline:[{order:0,name:"",file:"",purpose:"",appliesTo:""}],
    routeSpecific:{"entry_point":[str]}, registrationFile:"" }

security-graph:
  { authMechanism:"", tokenStrategy:{generation:"",validation:"",expiry:"",algorithm:"",secret:""},
    roles:{}, publicEntryPoints:[str], protectedEntryPoints:"" }

transform-graph:
  { "Name": { inputShape:{}, inputFile:"", transformFunction:"", transformFile:"",
    outputShape:{}, outputFile:"", excludedFields:[str] } }

error-graph:
  { customErrors:{ "Name": { extends:"", status:0, definedIn:"", thrownIn:[str] } },
    globalHandler:{file:"",behavior:"",logsBehavior:""} }

async-graph:
  { "funcName": { pattern:"", awaits:[{desc:"",blocking:bool}],
    parallelOps:[str], fireAndForget:[str] } }

test-graph:
  { framework:"", configFile:"", testFiles:{ "path": { covers:"", cases:[str], mocks:[str] } } }

integration-graph:
  { "Provider": { purpose:"", auth:"", calledFrom:"",
    operations:[{call:"",sends:{},receives:{}}] } }

job-graph:
  { "Name": { schedule:"", scheduledIn:"", implementation:"", calls:"",
    sideEffects:[str], failureHandling:"", type:"" } }

call-flow-graph:
  { "Use Case Label": { steps:[str] } }

architecture-graph:
  { type:"", layers:[str], patterns:[str], modules:[str],
    entryPoint:"", communicationProtocol:"", frontendExists:false }

imports-graph:
  { "relative/path/to/this/file": {
      imports:          [str],  // relative paths of LOCAL files this file imports FROM
      importedBy:       [str],  // filled by Graph Resolver — always leave [] here
      externalPackages: [str]   // npm / pip / maven / go module / cargo package names
  } }
`.trim();

// Compact one-line-per-graph hints (interpolated into the append tool's `data`
// parameter description). Field names here MUST match GRAPH_SHAPES_DOC above —
// they are the same canonical schema, just condensed.
export const GRAPH_SHAPE_HINTS: Record<string, string> = {
  'entity':       '{ "EntityName": { table, files:[...], fields:[{name,type,pk,fk,nullable,unique,...}], relations:[...] } }',
  'symbol':       '{ "funcName": { file, signature, returnType, executionModel, purpose, pseudocode, calledBy:[...], calls:[...], sideEffects:[...] } }',
  'rule':         '{ "domain": [{ rule, type, enforcement, violation, pseudocode:[...], relatedFiles:[...], migratable:bool }] }',
  'api':          '{ "METHOD /path": { handler, auth, request:{body,query,path}, responses:{}, middlewareChain:[...], files:[...] } }',
  'db':           '{ "tableName": { operations:[{ type, fields, condition, function, calledFrom:[...] }], repositoryFile, modelFile } }',
  'event':        '{ "event.name": { emittedIn, payload, listeners:[{ file, handler, does }], registrationFile } }',
  'config':       '{ "CONFIG_KEY": { type, required, default, purpose, usedIn:[...] } }',
  'state':        '{ "EntityName": { field, modelFile, states:[...], transitions:[...] } }',
  'middleware':   '{ globalPipeline:[{ order, name, file, purpose, appliesTo }], routeSpecific:{}, registrationFile }',
  'security':     '{ authMechanism, tokenStrategy:{}, roles:{}, publicEntryPoints:[...], protectedEntryPoints }',
  'transform':    '{ "Name": { inputShape:{}, inputFile, transformFunction, transformFile, outputShape:{}, outputFile, excludedFields:[...] } }',
  'error':        '{ customErrors:{ "ErrorName": { extends, status, definedIn, thrownIn:[...] } }, globalHandler:{ file, behavior, logsBehavior } }',
  'async':        '{ "funcName": { pattern, awaits:[...], parallelOps:[...], fireAndForget:[...] } }',
  'test':         '{ framework, configFile, testFiles:{ "path": { covers, cases:[...], mocks:[...] } } }',
  'integration':  '{ "Provider": { purpose, auth, calledFrom, operations:[...] } }',
  'job':          '{ "Job Name": { schedule, scheduledIn, implementation, calls, sideEffects:[...], failureHandling, type } }',
  'call-flow':    '{ "Use Case": { steps:[...] } }',
  'architecture': '{ type, layers:[...], patterns:[...], modules:[...], entryPoint, communicationProtocol, frontendExists }',
  'imports':      '{ "relative/path/file.ts": { imports:[...localPaths], importedBy:[...leave empty], externalPackages:[...packageNames] } }',
};

export function buildGraphShapeHintDoc(): string {
  return Object.entries(GRAPH_SHAPE_HINTS)
    .map(([name, hint]) => `${name}-graph: ${hint}`)
    .join(' ');
}
