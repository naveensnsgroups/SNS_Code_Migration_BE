

import { buildLanguageHint } from './file-analysis-prompt.js';
import { INFRASTRUCTURE_TASK_PREFIX } from '../agents/stage2/runners/shared.js';

export const CODE_GENERATOR_SYSTEM_PROMPT = `
<role>
You are a migration code generator. You translate legacy file(s) into ONE
target-stack file per turn. Usually that's one legacy file to one target file —
but sometimes the user prompt lists MULTIPLE legacy files for this same turn,
because the Migration Planner assigned them all to the same target path (e.g.
several route handlers that belong in one router file in the target framework).
When multiple legacy files are listed, your ONE write_file call must contain
the COMPLETE translated logic for EVERY one of them, combined into a single
coherent file — never drop one to make room for another, and never write only
the last one. Your translation MUST preserve each legacy file's exact business
logic and behavior — you are translating syntax and framework idioms, not
redesigning what the code does.
</role>

<react_loop>
THINK before each tool call. OBSERVE the result. DECIDE what to do next.
Never call two tools simultaneously.
</react_loop>

<steps>

<step id="G1" name="read_spec">
Read the knowledge graphs that describe EACH legacy file's behavior (there may
be more than one — see LEGACY FILE(S) in the user prompt) — these are your
PRIMARY translation spec, more precise than the raw source (they already
extracted the exact rule/function logic as numbered steps):
  - read-knowledge-graph("symbol")   — pseudocode for every function in these file(s)
  - read-knowledge-graph("rule")     — business rules whose relatedFiles include these file(s)
Then, based on each file's apparent role (infer from its path/typical structure),
also check whichever of these are relevant — skip ones that clearly don't apply:
  - route/controller file → read-knowledge-graph("api"), read-knowledge-graph("middleware")
  - model/schema file     → read-knowledge-graph("entity"), read-knowledge-graph("db")
  - auth/security file    → read-knowledge-graph("security")
  - error handling        → read-knowledge-graph("error")
  - async/background work → read-knowledge-graph("async"), read-knowledge-graph("job")
  - external API calls    → read-knowledge-graph("integration")
  - request/response DTOs → read-knowledge-graph("transform")
Only read graphs likely to actually contain entries for these files — do not
read all 19 graphs for every file, that wastes turns for no benefit.
</step>

<step id="G2" name="read_source_crosscheck">
Call getFileContent on EACH LEGACY file listed in the user prompt (one call
per file — if there are 3 legacy files for this turn, that's 3 calls). This is
a CROSS-CHECK, not your primary spec: the graphs from G1 are the authoritative
extracted logic; the raw source catches anything the extraction may have
missed (an edge case, a validation detail, a comment explaining a business
reason). If the graph and the source ever disagree on what the code actually
does, the source is ground truth — but still prefer translating from the
graph's clean pseudocode wherever it's unambiguous, since raw legacy syntax
carries incidental idiom that isn't a business rule.
</step>

<step id="G3" name="translate_and_write" priority="MANDATORY">
Write the COMPLETE target file content, translating:
  - Every function's pseudocode steps → equivalent logic in the target language/framework
  - Every business rule's pseudocode → the SAME validation/branch/error behavior,
    expressed in target-stack idiom (e.g. a target framework's own exception
    type instead of the legacy one, but the SAME condition and SAME outcome)
  - Database operations → target database's idiomatic query/ORM calls, same
    fields/conditions as the db-graph entries. TWO hard rules when writing
    database queries, because both are silent runtime failures a compile/import
    check will NOT catch:
      (a) DIALECT: use the TARGET database's SQL dialect, never the legacy
          database's. A function that existed in the source DB may not exist in
          the target (e.g. MySQL's DATE_FORMAT(col,'%Y-%m-%d') is not valid
          PostgreSQL — Postgres uses TO_CHAR(col,'YYYY-MM-DD')). Prefer the
          target stack's ORM, which emits the correct dialect automatically.
      (b) COLUMN NAMES: every column a query references MUST exactly match a
          column name defined in THIS project's own generated schema/models —
          never invent, abbreviate, or rename one (e.g. do not write RETURNING
          id when the schema's primary key column is task_id).
  - Route/middleware chains → target framework's routing/middleware idiom,
    same path, same auth requirement, same order

If MULTIPLE legacy files were listed for this turn, the output is ONE file
containing ALL of their translated logic side by side (e.g. multiple route
handlers in one router file) — translate every single one of them with the
same rigor as G1-G2 above, not just the first or the most obvious one.

Do NOT invent behavior that wasn't in the legacy pseudocode or source.
Do NOT drop a rule because it seemed minor — every rule in G1 must be visibly
present in the generated code. Do NOT drop an entire legacy file's logic
because another file in the same turn seemed more important.

If this file imports/uses another file that is ALSO being migrated, the user
prompt lists that dependency's EXACT already-assigned target path under
"ALREADY-GENERATED DEPENDENCIES" — that file EXISTS NOW, at that exact path.
Import it for real, using the correct import syntax for the target language
derived from that exact path. NEVER comment out an import "for a future step"
or write "assuming this will be added later" — every dependency you need has
already been generated before your turn started, because files are processed
in dependency order specifically so this is always true.

The exported-symbols list next to each dependency (name + async-ness) is a
QUICK reference, not always enough — it doesn't tell you a function's real
parameter names/order, its return shape, or a class's real constructor/fields.
If you need any of that to call a dependency correctly, call getFileContent
with workspace:"modern" and that EXACT target path to read its real, already-
written code before writing your own — the same way you'd open a real file in
an editor to check how to call it, instead of guessing from its name alone.

Action: call write_file with the COMPLETE file content. The destination path
is already locked server-side to the correct target file — whatever path
argument you pass is ignored, so just call write_file with any path value and
the full content.
</step>

</steps>

<constraints>
- Do NOT modify any legacy file — you only ever write to the target/output workspace.
- Do NOT ask the user questions — make your best translation decision and note
  any genuine ambiguity as a one-line code comment in the output instead.
- Do NOT split translation across multiple write_file calls — one complete
  file, one write_file call, then stop.
- Stop immediately after write_file succeeds.
- NEVER write a stub, placeholder, or "TODO: implement" in place of real logic.
  Phrases like "Implementation would go here", "assuming X will be added
  later", or a comment describing what the code should do INSTEAD of writing
  the code are treated as a failed generation and rejected automatically —
  every function must contain its actual translated logic, not a description
  of it.
- If a route/entrypoint file registers other files (routers, sub-modules),
  those registrations must be REAL, uncommented code — not commented out.
</constraints>
`;

export interface FrameworkConventions {
  routerPattern:    string;
  diPattern:        string;
  asyncConventions: string;
}

// Selects only the convention sections relevant to the file actually being
// generated, instead of always injecting the full router+DI+async bundle
// into every turn. A models.py turn has no use for Router Pattern's
// APIRouter/prefix/HTTPException rules; a schemas file has no use for any of
// the three. Same idea as Cursor's glob-matched rule files, but exact-match
// instead of pattern-guess, since this pipeline already knows the precise
// targetFile for every turn before it starts. An unrecognized file type falls
// back to the full bundle — never silently drop guidance for a file type
// this matcher doesn't know about yet.
export function selectRelevantConventions(
  skill: { routerPattern: string; diPattern: string; asyncConventions: string },
  targetFile: string
): FrameworkConventions {
  const full = { routerPattern: skill.routerPattern, diPattern: skill.diPattern, asyncConventions: skill.asyncConventions };

  const isRouter = /[/\\](routers|routes)[/\\]/.test(targetFile);
  if (isRouter) return full;

  const isModels = /(^|[/\\])models\.py$/.test(targetFile) || /[/\\]models[/\\]/.test(targetFile);
  const isDbFile = /(^|[/\\])db\.py$/.test(targetFile);
  if (isModels || isDbFile) {
    return { routerPattern: '', diPattern: skill.diPattern, asyncConventions: skill.asyncConventions };
  }

  const isSchema = /[/\\]schemas[/\\]/.test(targetFile);
  if (isSchema) return { routerPattern: '', diPattern: '', asyncConventions: '' };

  return full; // unrecognized file type — safe fallback, nothing regresses
}

export function buildCodeGeneratorUserPrompt(
  legacyFiles:   string | string[],
  targetFile:    string,
  rulesInvolved: string[],
  targetStack:   { framework: string; database: string; language: string; testFramework: string },
  language?:     string,
  framework?:    string,
  dependencyTargets?: Array<{ legacyFile: string; targetFile: string; exportedSymbols?: { name: string; isAsync: boolean }[] }>,
  previousError?: string,
  // Scaffolding tasks (see buildScaffoldingTasks) have no legacy source — this
  // is the matching ScaffoldingFile.generationBrief from the resolved skill,
  // telling this turn exactly what to build instead of guessing per-kind.
  scaffoldingBrief?: string,
  // Curated router/DI/async conventions for the resolved target-framework
  // skill — injected for REAL (non-scaffolding) files so every turn follows
  // the same idiom instead of each one improvising its own.
  frameworkConventions?: FrameworkConventions
): string {
  const files = Array.isArray(legacyFiles) ? legacyFiles : [legacyFiles];

  // A scaffolding file (see buildScaffoldingTasks) has no legacy source or
  // knowledge graph — it's new supporting infrastructure the target stack
  // needs, not a translation of anything. G1 (read graphs) and G2 (read
  // legacy source) don't apply; skip straight to G3 with the skill's own brief.
  if (files.length === 1 && files[0].startsWith(INFRASTRUCTURE_TASK_PREFIX)) {
    const brief = scaffoldingBrief
      ?? 'Generate this required supporting file for the target stack described below. Real, complete, working code — not a stub.';

    // Critical for the entrypoint specifically: it needs the REAL target path
    // of every router it mounts. Without this, a real run confirmed the model
    // falls back to guessing a generic path ("app/routes/<legacyFileName>")
    // instead of the actual generated path ("app/routers/<real_name>.py") —
    // a guaranteed ModuleNotFoundError. Same list, same format, as the
    // real-file branch below — scaffolding tasks need this exactly as much.
    const depsList = dependencyTargets && dependencyTargets.length > 0
      ? dependencyTargets.map(d => {
          const exports = d.exportedSymbols && d.exportedSymbols.length > 0
            ? ` — exports: ${d.exportedSymbols.map(s => s.isAsync ? `async ${s.name}()` : s.name).join(', ')}`
            : '';
          return `  - ${d.legacyFile}  ->  ${d.targetFile}  (already generated — import from here)${exports}`;
        }).join('\n')
      : '  (nothing already generated that this file depends on)';

    return `${buildLanguageHint(language, framework)}This turn does NOT translate a legacy file — SKIP steps G1 and G2 entirely, there is no legacy source or knowledge graph for this task. Go straight to G3.

${brief}

Target file:  ${targetFile}  (write destination is locked to this path)

TARGET STACK:
  Framework: ${targetStack.framework}
  Language:  ${targetStack.language}
  Database:  ${targetStack.database}

ALREADY-GENERATED DEPENDENCIES (import these EXACT paths — do not guess a different path or filename):
${depsList}

Action: call write_file with the COMPLETE file content, then stop.`;
  }

  const rulesList = rulesInvolved.length > 0
    ? rulesInvolved.map((r, i) => `  ${i + 1}. ${r}`).join('\n')
    : '  (none identified in rule-graph for this file)';

  const depsList = dependencyTargets && dependencyTargets.length > 0
    ? dependencyTargets.map(d => {
        const exports = d.exportedSymbols && d.exportedSymbols.length > 0
          ? ` — exports: ${d.exportedSymbols.map(s => s.isAsync ? `async ${s.name}()` : `${s.name}`).join(', ')}` +
            (d.exportedSymbols.some(s => s.isAsync) ? ' (any async export listed here MUST be awaited by its caller)' : '')
          : '';
        return `  - ${d.legacyFile}  ->  ${d.targetFile}  (already generated — import from here)${exports}`;
      }).join('\n')
    : '  (this file has no local dependencies on other migrated files)';

  const retryNote = previousError
    ? `\nPREVIOUS ATTEMPT(S) FAILED VERIFICATION:\n${previousError}\nFix this specific problem in your rewrite — do not repeat what a previous attempt already tried and failed; re-check the ALREADY-GENERATED DEPENDENCIES list above for the exact correct path.\n`
    : '';

  const filesList = files.length > 1
    ? files.map((f, i) => `  ${i + 1}. ${f}`).join('\n')
    : `  ${files[0]}`;
  const mergeNote = files.length > 1
    ? `\nThese ${files.length} legacy files were all assigned this SAME target file — translate ALL of them and combine ` +
      `their logic into this ONE output file (e.g. multiple route handlers in one router file). Do not drop any of them.\n`
    : '';

  const conventionSections = frameworkConventions
    ? [
        frameworkConventions.routerPattern    && `Router pattern:\n${frameworkConventions.routerPattern}`,
        frameworkConventions.diPattern        && `Dependency injection pattern:\n${frameworkConventions.diPattern}`,
        frameworkConventions.asyncConventions && `Async conventions:\n${frameworkConventions.asyncConventions}`,
      ].filter((s): s is string => !!s)
    : [];
  const conventionsBlock = conventionSections.length > 0
    ? `\nTARGET FRAMEWORK CONVENTIONS for ${targetStack.framework} (follow exactly — do not use a different pattern):\n` +
      conventionSections.join('\n\n') + '\n'
    : '';

  return `${buildLanguageHint(language, framework)}Translate ${files.length > 1 ? `these ${files.length} legacy files` : 'this ONE legacy file'} to the target stack.

Legacy file(s):
${filesList}
Target file:  ${targetFile}  (write destination is locked to this path)
${mergeNote}

TARGET STACK:
  Framework:      ${targetStack.framework}
  Language:       ${targetStack.language}
  Database:       ${targetStack.database}
  Test framework: ${targetStack.testFramework}
${conventionsBlock}
ALREADY-GENERATED DEPENDENCIES (import these for real — they exist now):
${depsList}
${retryNote}
Business rules that MUST remain visibly enforced in the generated file:
${rulesList}

Follow G1 (read spec graphs) → G2 (read legacy source as cross-check) → G3 (write complete translated file).
Stop after write_file succeeds.`;
}
