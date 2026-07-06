# SNS Code Migration — Engineering Standards (Stage 1 Pipeline)

These standards exist because the Stage 1 pipeline drives many concurrent LLM
agents through a generic tool-calling loop, and small violations here produce
silent data corruption (empty sections, undercounted tokens, orphaned progress).
They are enforceable in review: a violation is a reviewable diff, not a runtime
surprise. Written 2026-07-03 as part of the Stage 1 stabilization pass.

---

## 1. Coding Standard

1. **Structured errors only.** Every tool that can fail returns
   `makeToolErrorResult(...)` (content type `'error'`) — never a text-wrapped
   `{error:...}` disguised as a success. The executor's stuck-tool /
   duplicate-call / no-progress detectors key off `is_error`, which only reads
   the `'error'` content type. A text-wrapped error is invisible to them.

2. **Single-writer for shared state.** Any disk-persisted state shared by
   concurrent callers is written through exactly one serialized path:
   - Session file → `SessionManager.enqueueWrite`
   - Task context → `TaskContextManager.updateContext` / `.transformContext`
     (both use `enqueueKeyedWrite('taskContext:<id>')`)
   - Knowledge graphs → `enqueueKeyedWrite('graph:<path>')` around the whole
     read→merge→write cycle.
   No tool may do a bare read→merge→write on a shared file outside its queue.

3. **Resilient reads.** Any JSON read of a file that a concurrent writer may be
   renaming into place uses `readJsonWithRetry`, never bare `fs.readJson`.

4. **Guard every `JSON.parse` of LLM-supplied args** with try/catch that returns
   a clean `makeToolErrorResult`, plus a presence/type check on required fields.

5. **Consistent response shape within a tool.** A tool must not return "raw
   string on success, JSON error object on failure" as two conflated types.

6. **Delete retired code in the same change that retires it.** Never leave a
   dead agent registered or a dead registry object in the tree "just in case."
   (This is literally how the dead `migration-planner-stage1` agent and the
   1600-line `TOOLS_REGISTRY` object accumulated.)

7. **One canonical schema per data shape.** Knowledge-graph shapes live in
   `src/tools/knowledge/graph-schemas.ts` and are imported by both the tool
   description and the analysis prompt. Never hand-copy a field name into a
   prompt or tool description — copies drift (they already did: `isAsync` vs
   `executionModel`, `publicRoutes` vs `publicEntryPoints`).

## 1b. Tool Standard (every tool must pass all 7)

The LLM decides which tool to call by reading tool **descriptions** — the description
IS the decision surface. A wrong/biased/inaccurate description makes the model make
wrong decisions that no prompt can fix. Every tool must satisfy:

1. **Description = behavior.** The description states only what the handler actually
   does. No lying, no overclaiming, no false guarantees. (Fixed examples:
   `getDependencyTree` claimed `*.csproj` support it never had; `extractFileSymbols`
   presented a regex best-effort scan as a complete "symbol map.")
2. **Neutral, not biased.** Describe what the tool does and when it applies — never
   nudge the model toward a particular answer or a guess.
3. **Consistent result shape.** Success returns a uniform structured result; failure
   returns `makeToolErrorResult(<plain message>)` — a plain human-readable string,
   NOT `JSON.stringify({error})`. No tool mixes "string on success, JSON on failure."
4. **Guarded inputs.** Parse model args with `parseToolArgs(arg_string, toolName)`
   from `src/tools/tool-args.ts` — never a bare `JSON.parse`. Validate required
   fields (`requireStringArg`, or an explicit check) before use.
5. **Schema matches handler.** Every declared parameter is actually read; every field
   the description promises is actually produced.
6. **Safe writes/reads.** Shared-file writes go through the write queue; concurrent-read
   files use `readJsonWithRetry`.
7. **Language-agnostic.** No assumption that the codebase is one specific stack;
   where a tool is inherently partial (e.g. regex symbol extraction), the description
   says so honestly.

## 2. Prompting Standard

1. **Pin canonical key names as literal quoted strings at every save/read site**
   in the SYSTEM prompt — not just once in a dynamically-built user prompt. The
   FILE_INDEX key drift bug came from `"file-index"` being pinned only in the
   user prompt while the system prompt said `FILE_INDEX` in prose.

2. **Self-verify checks must be falsifiable against an independent signal.**
   Comparing a count to itself, or to a value the same pass just computed, is
   not a check. Compare against a different phase's output or a hard external
   fact (e.g. a filesystem glob count), not the model's own memory.

3. **"Empty is valid" escape hatches must enumerate ALL counter states** — zero,
   missing, below-threshold-nonzero, above-threshold — not just the convenient
   ones. A non-zero counter with an empty graph is ALWAYS a data gap.

4. **Every data shape in a prompt matches the tool schema field-for-field.**

5. **Cross-phase promises are verified from both ends.** If phase A's prompt says
   "phase B computes X," phase B's prompt must actually agree.

6. **Recovery/fallback prompts recover the COMPLETE contract** of the primary
   pass, not a subset (Pass D must save every counter Pass C saves).

## 2b. Agentic Loop & Observability Standard

1. **Every agent run has a productive-progress guard.** Loop detection must catch
   not only errors and identical-arg duplicates, but also *successful spinning* — an
   agent making many bookkeeping-only calls (get/edit task context, todoWrite) with no
   productive work (file read / graph write) in between. After `bookkeepingStreakMax`
   such calls, inject a recovery nudge to do real work or stop. (This was the blind spot
   that let `edit_task_context` spin dozens of times, burning calls and hitting rate limits.)
2. **A run must be bounded.** Phases that call the LLM in a loop pass a per-run
   `maxIterations` cap sized to the work (e.g. analysis = f(batchSize)), never relying on
   the global ceiling — so one pass cannot exhaust a rate-limited token/minute budget.
3. **Every tool call emits its REAL result to the observability channel.** After executing
   a tool, log `[Tool Data] <actual result>` (capped generously, ~12KB, with an honest
   truncation marker) and broadcast the args + result preview on `tool_response`. The UI
   shows what each tool actually did and returned — never just "completed successfully."
   (Regression watch: moving tool execution between layers must preserve this emit — losing
   it is exactly how the UI went blind after loop centralization.)
4. **Prompts must specify how to STOP** — a final plain-text message with no tool call —
   and forbid re-saving unchanged state.

## 3. Agent Methodology Standard

1. **One agent = one purpose-built prompt.** Never share a system prompt across
   two agents with different responsibilities.

2. **An agent's `description` must match its assigned prompt's stated scope.**
   If they disagree, the definition is wrong by construction.

3. **Retiring an agent = removing it from every registry in the same change**
   (`AgentRegistry`, `agentService`, `ALL_AGENT_DEFINITIONS`) — not leaving it
   discoverable via `/api/config/agents`.

4. **The tool-call execution loop has exactly ONE owner: `AgentExecutor`.** No
   provider or agent may execute tools or self-recurse. Providers stream a single
   turn (text + usage + tool calls with full args, `finished:false`) and stop;
   the executor executes, runs loop/stuck/duplicate detection, appends results,
   and re-invokes `request()`. (Self-executing providers previously made every
   executor safety net dead code.)

5. **Model-alias resolution goes through one central resolver** with defined
   fallback order — never parsed ad hoc per caller.

6. **Each phase transition updates `active_phase` atomically** with the data it
   describes, so every checkpoint is cleanly resumable and cancellable.

---

## Data-integrity invariants (Stage 1)

- **Dedup is key-order-independent.** `deduplicatedAppend` (knowledge-graph-utils)
  canonicalizes with sorted keys before comparison, so the same logical rule/test/
  transform emitted with keys in a different order does not duplicate and inflate counts.
- **Context compaction never splits a tool_use/tool_result pair.** The retained tail
  is trimmed so it never begins with an orphaned tool_result (all providers 400 on that).
- **architecture-graph has two valid shapes** — a flat top-level object (Phase 2) and a
  nested `synthesized_overview` (Phase 3). Any consumer must read BOTH; neither is authoritative alone.

## Verification note (Phase 5)

The provider/executor loop centralization changes the streaming contract for the
Anthropic, Google, and Mistral providers. It type-checks and the message
round-trip uses the already-exercised transform functions, but it has NOT been
validated against live provider APIs in this environment. Before production use,
run one full Stage 1 pass per provider and confirm: multi-turn tool calls work,
token usage accrues, and no provider returns a 400 on message structure.
