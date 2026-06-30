// =============================================================================
//  graph-resolver.ts — Stage 1, Phase 3: TypeScript Graph Intelligence Layer
//
//  Replaces LLM Pass A (FK resolution) + Pass B (call-flow) + Pass C step C0
//  (importedBy computation) with pure TypeScript logic.
//
//  Zero LLM calls. Zero hallucination. Deterministic output.
//  All three functions read from and write to the graph JSON files directly,
//  using the same path convention as append-to-knowledge-graph.tool.ts:
//    modernPath/_analysis/{graphName}-graph.json
//
//  Called by planner-agent.ts in Phase 3, before the LLM Pass C (architecture
//  synthesis) — the one remaining LLM call in graph resolution.
// =============================================================================

import path from 'path';
import fs   from 'fs-extra';

// =============================================================================
//  resolveForeignKeys
//  Replaces LLM Pass A.
//
//  Reads entity-graph.json. For every field where fk=true or the field type
//  matches another entity name: adds bidirectional relation entries to both
//  the source entity and the target entity.
//
//  Returns the number of FK relations resolved.
//
//  Language-agnostic detection:
//    - field.fk === true            (agent already marked it as FK)
//    - field.name ends in 'Id'/'_id'/'Ref'/'_ref'/'Key'/'_key'
//    - field.type exactly matches a known entity name
//    - field.relatedEntity is set (some agents write this explicitly)
// =============================================================================
export async function resolveForeignKeys(modernPath: string): Promise<number> {
  const graphPath = path.join(modernPath, '_analysis', 'entity-graph.json');

  if (!(await fs.pathExists(graphPath))) {
    return 0;
  }

  let graph: Record<string, any>;
  try {
    graph = await fs.readJson(graphPath);
  } catch {
    return 0; // corrupt graph — skip, don't crash
  }

  // Build the set of all known entity names for cross-reference matching
  const entityNames = new Set(
    Object.keys(graph).filter(k => k !== '_sources')
  );

  if (entityNames.size === 0) return 0;

  let resolved = 0;

  for (const [entityName, entity] of Object.entries(graph)) {
    if (entityName === '_sources' || !entity || typeof entity !== 'object') continue;

    const fields: any[] = Array.isArray(entity.fields) ? entity.fields : [];

    for (const field of fields) {
      if (!field || typeof field !== 'object') continue;

      // Detect FK by multiple signals (language-agnostic)
      const isFkByFlag    = field.fk === true;
      const isFkByName    = typeof field.name === 'string' && (
        field.name.endsWith('Id')  || field.name.endsWith('_id') ||
        field.name.endsWith('Ref') || field.name.endsWith('_ref') ||
        field.name.endsWith('Key') || field.name.endsWith('_key')
      );
      const isFkByType    = typeof field.type === 'string' && entityNames.has(field.type);
      const hasRelatedEntity = typeof field.relatedEntity === 'string' && field.relatedEntity.length > 0;

      if (!isFkByFlag && !isFkByName && !isFkByType && !hasRelatedEntity) continue;

      // Determine the target entity name
      let targetName: string | undefined;

      if (hasRelatedEntity && entityNames.has(field.relatedEntity)) {
        targetName = field.relatedEntity;
      } else if (isFkByType) {
        targetName = field.type;
      } else if (isFkByName) {
        // Infer: "userId" → look for "User" entity
        const stem = field.name
          .replace(/_?[Ii]d$/, '')
          .replace(/_?[Rr]ef$/, '')
          .replace(/_?[Kk]ey$/, '');
        // Case-insensitive match against entity names
        targetName = [...entityNames].find(
          e => e.toLowerCase() === stem.toLowerCase()
        );
      }

      if (!targetName || !graph[targetName]) continue;

      // ── Add relation to SOURCE entity (belongsTo) ──────────────────────────
      entity.relations = entity.relations ?? [];
      const alreadySource = entity.relations.some(
        (r: any) => r.type === 'belongsTo' && r.target === targetName && r.fk === field.name
      );
      if (!alreadySource) {
        entity.relations.push({
          type:   'belongsTo',
          target: targetName,
          fk:     field.name,
        });
        resolved++;
      }

      // ── Add reverse relation to TARGET entity (hasMany) ────────────────────
      graph[targetName].relations = graph[targetName].relations ?? [];
      const alreadyTarget = graph[targetName].relations.some(
        (r: any) => r.type === 'hasMany' && r.target === entityName && r.viaFk === field.name
      );
      if (!alreadyTarget) {
        graph[targetName].relations.push({
          type:   'hasMany',
          target: entityName,
          viaFk:  field.name,
        });
      }
    }
  }

  if (resolved > 0) {
    try {
      await fs.writeJson(graphPath, graph, { spaces: 2 });
    } catch {
      // Non-fatal — FK data is enhancement, not blocker
    }
  }

  return resolved;
}

// =============================================================================
//  computeImportedBy
//  Replaces LLM Pass C step C0.
//
//  Reads imports-graph.json. For every file A that lists file B in its
//  imports[] array: adds A to B's importedBy[] array.
//  This creates the reverse import index used for MIGRATION_ORDER scoring.
//
//  Also computes a basic dependency score per file:
//    dependencyScore = importedBy.length (how many files depend on this file)
//  Files with the highest score should be migrated first.
// =============================================================================
export async function computeImportedBy(modernPath: string): Promise<void> {
  const graphPath = path.join(modernPath, '_analysis', 'imports-graph.json');

  if (!(await fs.pathExists(graphPath))) {
    return;
  }

  let graph: Record<string, any>;
  try {
    graph = await fs.readJson(graphPath);
  } catch {
    return;
  }

  // Reset all importedBy arrays so we compute from scratch (idempotent)
  for (const [key, entry] of Object.entries(graph)) {
    if (key === '_sources' || !entry || typeof entry !== 'object') continue;
    entry.importedBy = [];
  }

  // Build reverse index: for each file A importing B → add A to B.importedBy
  for (const [filePath, entry] of Object.entries(graph)) {
    if (filePath === '_sources' || !entry || typeof entry !== 'object') continue;

    const imports: string[] = Array.isArray(entry.imports) ? entry.imports : [];
    for (const imported of imports) {
      if (!imported || imported === filePath) continue; // skip self-imports

      // Normalise path separators for cross-platform matching
      const normalised = imported.replace(/\\/g, '/');
      if (graph[normalised] && typeof graph[normalised] === 'object') {
        graph[normalised].importedBy = graph[normalised].importedBy ?? [];
        if (!graph[normalised].importedBy.includes(filePath)) {
          graph[normalised].importedBy.push(filePath);
        }
      }
    }
  }

  // Compute dependencyScore per file (importedBy.length)
  for (const [key, entry] of Object.entries(graph)) {
    if (key === '_sources' || !entry || typeof entry !== 'object') continue;
    entry.dependencyScore = Array.isArray(entry.importedBy) ? entry.importedBy.length : 0;
  }

  try {
    await fs.writeJson(graphPath, graph, { spaces: 2 });
  } catch {
    // Non-fatal
  }
}

// =============================================================================
//  buildCallFlowGraph
//  Replaces LLM Pass B.
//
//  Reads api-graph.json and symbol-graph.json.
//  For each entry point in api-graph:
//    - Finds the handler function in symbol-graph
//    - Follows calls[] arrays recursively to build the execution chain
//    - Writes the result to call-flow-graph.json
//
//  Cycle guard: tracked visited set per traversal — max depth 12.
//  Returns number of entry points traced.
// =============================================================================
export async function buildCallFlowGraph(modernPath: string): Promise<number> {
  const analysisDir = path.join(modernPath, '_analysis');
  const apiPath     = path.join(analysisDir, 'api-graph.json');
  const symbolPath  = path.join(analysisDir, 'symbol-graph.json');
  const cfPath      = path.join(analysisDir, 'call-flow-graph.json');

  const apiExists    = await fs.pathExists(apiPath);
  const symbolExists = await fs.pathExists(symbolPath);

  if (!apiExists || !symbolExists) return 0;

  let apiGraph: Record<string, any>;
  let symbolGraph: Record<string, any>;

  try {
    apiGraph    = await fs.readJson(apiPath);
    symbolGraph = await fs.readJson(symbolPath);
  } catch {
    return 0;
  }

  // Build a normalised function lookup: lowercased name → symbol entry
  // Handles cases where agent wrote "UserService.findUser" vs "findUser"
  const symbolLookup = new Map<string, any>();
  for (const [key, sym] of Object.entries(symbolGraph)) {
    if (key === '_sources') continue;
    symbolLookup.set(key, sym);
    // Also index by simple name (last segment after dot or colon)
    const simpleName = key.split('.').pop()?.split(':')[0];
    if (simpleName && simpleName !== key && !symbolLookup.has(simpleName)) {
      symbolLookup.set(simpleName, sym);
    }
  }

  // ── Recursive chain tracer ─────────────────────────────────────────────────
  function traceChain(
    fnName:  string,
    visited: Set<string>,
    depth:   number
  ): string[] {
    if (depth > 12) return [`${fnName} (max depth)`];
    if (visited.has(fnName)) return [`${fnName} (cycle)`];

    visited.add(fnName);
    const symbol = symbolLookup.get(fnName);
    if (!symbol) return [fnName]; // leaf — not in symbol graph

    const chain: string[] = [fnName];
    const calls: string[] = Array.isArray(symbol.calls) ? symbol.calls : [];

    for (const called of calls) {
      // calls[] entries may be "funcName", "funcName:file", or "ClassName.method"
      const calledName = called.split(':')[0].trim();
      if (!calledName || calledName === fnName) continue;
      chain.push(...traceChain(calledName, new Set(visited), depth + 1));
    }

    return chain;
  }

  // ── Build call-flow entries ────────────────────────────────────────────────
  const callFlowGraph: Record<string, any> = {};
  let traced = 0;

  for (const [entryPoint, route] of Object.entries(apiGraph)) {
    if (entryPoint === '_sources' || !route || typeof route !== 'object') continue;

    const handler = typeof route.handler === 'string' ? route.handler : undefined;
    if (!handler) continue;

    const executionChain = traceChain(handler, new Set(), 0);

    // Collect unique source files from all symbols in the chain
    const files = new Set<string>();
    for (const fn of executionChain) {
      const sym = symbolLookup.get(fn);
      if (sym?.file) files.add(sym.file);
    }

    callFlowGraph[entryPoint] = {
      entryPoint,
      handler,
      executionChain,
      files:       [...files],
      chainLength: executionChain.length,
    };

    traced++;
  }

  // Preserve _sources if call-flow-graph already exists (idempotent)
  let existingSources: string[] = [];
  try {
    if (await fs.pathExists(cfPath)) {
      const existing = await fs.readJson(cfPath);
      if (Array.isArray(existing._sources)) {
        existingSources = existing._sources;
      }
    }
  } catch { /* start fresh */ }

  if (existingSources.length > 0) {
    callFlowGraph._sources = existingSources;
  }

  try {
    await fs.writeJson(cfPath, callFlowGraph, { spaces: 2 });
  } catch {
    // Non-fatal
  }

  return traced;
}

// =============================================================================
//  computeMigrationOrder
//  Bonus: computes the top-50 most-depended-on files from imports-graph.
//  Saves result to task context via a returned array (caller saves to context).
//  Called by planner-agent.ts after computeImportedBy().
// =============================================================================
export async function computeMigrationOrder(modernPath: string): Promise<string[]> {
  const graphPath = path.join(modernPath, '_analysis', 'imports-graph.json');

  if (!(await fs.pathExists(graphPath))) return [];

  let graph: Record<string, any>;
  try {
    graph = await fs.readJson(graphPath);
  } catch {
    return [];
  }

  const scored: { path: string; score: number }[] = [];

  for (const [filePath, entry] of Object.entries(graph)) {
    if (filePath === '_sources' || !entry || typeof entry !== 'object') continue;
    const score = typeof entry.dependencyScore === 'number'
      ? entry.dependencyScore
      : (Array.isArray(entry.importedBy) ? entry.importedBy.length : 0);
    if (score > 0) {
      scored.push({ path: filePath, score });
    }
  }

  // Sort descending by score — most depended-on files first
  scored.sort((a, b) => b.score - a.score);

  // Return top 50 file paths
  return scored.slice(0, 50).map(e => e.path);
}
