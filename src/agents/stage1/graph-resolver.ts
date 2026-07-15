

import path from 'path';
import fs   from 'fs-extra';
import { TaskContextManager } from '../../session/taskContext.js';
import { LogFn } from '../core/agent-concurrency-utils.js';

export async function resolveForeignKeys(modernPath: string): Promise<number> {
  const graphPath = path.join(modernPath, '_analysis', 'entity-graph.json');

  if (!(await fs.pathExists(graphPath))) {
    return 0;
  }

  let graph: Record<string, any>;
  try {
    graph = await fs.readJson(graphPath);
  } catch {
    return 0; 
  }

  
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

      
      const isFkByFlag    = field.fk === true;
      const isFkByName    = typeof field.name === 'string' && (
        field.name.endsWith('Id')  || field.name.endsWith('_id') ||
        field.name.endsWith('Ref') || field.name.endsWith('_ref') ||
        field.name.endsWith('Key') || field.name.endsWith('_key')
      );
      const isFkByType    = typeof field.type === 'string' && entityNames.has(field.type);
      const hasRelatedEntity = typeof field.relatedEntity === 'string' && field.relatedEntity.length > 0;

      if (!isFkByFlag && !isFkByName && !isFkByType && !hasRelatedEntity) continue;

      
      let targetName: string | undefined;

      if (hasRelatedEntity && entityNames.has(field.relatedEntity)) {
        targetName = field.relatedEntity;
      } else if (isFkByType) {
        targetName = field.type;
      } else if (isFkByName) {
        
        const stem = field.name
          .replace(/_?[Ii]d$/, '')
          .replace(/_?[Rr]ef$/, '')
          .replace(/_?[Kk]ey$/, '');
        
        targetName = [...entityNames].find(
          e => e.toLowerCase() === stem.toLowerCase()
        );
      }

      if (!targetName || !graph[targetName]) continue;

      
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
      
    }
  }

  return resolved;
}

// Resolves one raw `imports` entry to the project-root-relative path format
// used as graph keys throughout (e.g. "backend/routes/userRoute.js"). Models
// write imports exactly as they appear in the source file — "./routes/x.js"
// or "../models/y.js" — which is relative to the IMPORTING file's directory,
// not the project root. Matching that raw string against graph keys directly
// never works (they're different strings), so every local dependency looked
// invisible: importedBy stayed empty and MIGRATION_ORDER had nothing to sort.
// Also strips the same stray-quote artifact the graph keys themselves can
// carry (see append-to-knowledge-graph.tool.ts) — defensive, since a match
// attempt against a quote-wrapped string would silently fail the same way.
export function resolveLocalImportPath(importingFile: string, rawImport: string): string {
  let normalized = (rawImport ?? '').replace(/\\/g, '/');
  for (const q of ['"', "'", '`']) {
    if (normalized.length > 1 && normalized.startsWith(q) && normalized.endsWith(q)) {
      normalized = normalized.slice(1, -1);
      break;
    }
  }
  if (normalized.startsWith('./') || normalized.startsWith('../')) {
    const importingDir = path.posix.dirname(importingFile.replace(/\\/g, '/'));
    normalized = path.posix.normalize(path.posix.join(importingDir, normalized));
  }
  return normalized;
}

// Strips a stray leading+trailing literal quote pair (double, single, or backtick)
// from every top-level key of a graph object (see the sanitization note in
// append-to-knowledge-graph.tool.ts). Applied on READ so graphs written before
// that fix existed self-heal on the next resolver pass, instead of staying
// permanently broken.
export function normalizeGraphKeys(graph: Record<string, any>): Record<string, any> {
  const normalized: Record<string, any> = {};
  for (const [key, value] of Object.entries(graph)) {
    let cleanKey = key;
    for (const q of ['"', "'", '`']) {
      if (key.length > 1 && key.startsWith(q) && key.endsWith(q)) {
        cleanKey = key.slice(1, -1);
        break;
      }
    }
    normalized[cleanKey] = value;
  }
  return normalized;
}

export async function computeImportedBy(modernPath: string): Promise<void> {
  const graphPath = path.join(modernPath, '_analysis', 'imports-graph.json');

  if (!(await fs.pathExists(graphPath))) {
    return;
  }

  let graph: Record<string, any>;
  try {
    graph = normalizeGraphKeys(await fs.readJson(graphPath));
  } catch {
    return;
  }


  for (const [key, entry] of Object.entries(graph)) {
    if (key === '_sources' || !entry || typeof entry !== 'object') continue;
    entry.importedBy = [];
  }

  
  for (const [filePath, entry] of Object.entries(graph)) {
    if (filePath === '_sources' || !entry || typeof entry !== 'object') continue;

    const imports: string[] = Array.isArray(entry.imports) ? entry.imports : [];
    for (const imported of imports) {
      if (!imported) continue;

      const resolved = resolveLocalImportPath(filePath, imported);
      if (resolved === filePath) continue;

      if (graph[resolved] && typeof graph[resolved] === 'object') {
        graph[resolved].importedBy = graph[resolved].importedBy ?? [];
        if (!graph[resolved].importedBy.includes(filePath)) {
          graph[resolved].importedBy.push(filePath);
        }
      }
    }
  }

  
  for (const [key, entry] of Object.entries(graph)) {
    if (key === '_sources' || !entry || typeof entry !== 'object') continue;
    entry.dependencyScore = Array.isArray(entry.importedBy) ? entry.importedBy.length : 0;
  }

  try {
    await fs.writeJson(graphPath, graph, { spaces: 2 });
  } catch {

  }
}

// Reconciles request/response shapes a handler/controller file staged before it
// could determine its own api-graph key (see HANDLER FILE → REQUEST/RESPONSE
// SHAPES in file-analysis-prompt.ts). Runs deterministically — no LLM call — so
// it works regardless of which order the route file vs. handler file happened
// to be analyzed in, and is language-agnostic (pure name/key matching, no
// per-framework logic).
export async function reconcilePendingHandlerShapes(sessionId: string, modernPath: string): Promise<number> {
  const ctx = await TaskContextManager.getContext(sessionId);
  const pending: Record<string, { request?: unknown; responses?: unknown }> =
    ctx.PENDING_HANDLER_SHAPES && typeof ctx.PENDING_HANDLER_SHAPES === 'object'
      ? ctx.PENDING_HANDLER_SHAPES
      : {};
  if (Object.keys(pending).length === 0) return 0;

  const handlerToRouteKey: Record<string, string> =
    ctx.HANDLER_TO_ROUTE_KEY && typeof ctx.HANDLER_TO_ROUTE_KEY === 'object'
      ? ctx.HANDLER_TO_ROUTE_KEY
      : {};

  const graphPath = path.join(modernPath, '_analysis', 'api-graph.json');
  if (!(await fs.pathExists(graphPath))) return 0;

  let graph: Record<string, any>;
  try {
    graph = normalizeGraphKeys(await fs.readJson(graphPath));
  } catch {
    return 0;
  }

  let reconciled = 0;
  for (const [handlerName, shape] of Object.entries(pending)) {
    // Primary lookup: the mapping the route file saved when it recorded this handler.
    let routeKey = handlerToRouteKey[handlerName];

    // Fallback: no mapping was ever saved (e.g. the route file genuinely used a
    // different name internally) — scan existing api-graph entries for one whose
    // own recorded `handler` field matches this function name exactly.
    if (!routeKey) {
      const match = Object.entries(graph).find(
        ([key, entry]) => key !== '_sources' && entry?.handler === handlerName
      );
      if (match) routeKey = match[0];
    }

    if (!routeKey || !graph[routeKey] || typeof graph[routeKey] !== 'object') continue;

    if (shape.request && typeof shape.request === 'object') {
      graph[routeKey].request = { ...(graph[routeKey].request ?? {}), ...shape.request };
    }
    if (shape.responses && typeof shape.responses === 'object') {
      graph[routeKey].responses = { ...(graph[routeKey].responses ?? {}), ...shape.responses };
    }
    reconciled++;
  }

  if (reconciled > 0) {
    try {
      await fs.writeJson(graphPath, graph, { spaces: 2 });
    } catch {

    }
  }

  return reconciled;
}

export interface CallFlowResult {
  traced:  number;
  // Entry points whose handler never resolved to a symbol-graph entry — the
  // chain is just [handler] with no files attributed. Usually means the
  // handler is a router/mount object, not a real controller function (see
  // ROUTE MOUNTING rules in file-analysis-prompt.ts), or the symbol simply
  // wasn't extracted. Either way, downstream Stage 2 consumers should not
  // trust these chains as complete.
  shallow: string[];
}

export async function buildCallFlowGraph(modernPath: string): Promise<CallFlowResult> {
  const analysisDir = path.join(modernPath, '_analysis');
  const apiPath     = path.join(analysisDir, 'api-graph.json');
  const symbolPath  = path.join(analysisDir, 'symbol-graph.json');
  const cfPath      = path.join(analysisDir, 'call-flow-graph.json');

  const apiExists    = await fs.pathExists(apiPath);
  const symbolExists = await fs.pathExists(symbolPath);

  if (!apiExists || !symbolExists) return { traced: 0, shallow: [] };

  let apiGraph: Record<string, any>;
  let symbolGraph: Record<string, any>;

  try {
    apiGraph    = normalizeGraphKeys(await fs.readJson(apiPath));
    symbolGraph = await fs.readJson(symbolPath);
  } catch {
    return { traced: 0, shallow: [] };
  }

  
  
  const symbolLookup = new Map<string, any>();
  for (const [key, sym] of Object.entries(symbolGraph)) {
    if (key === '_sources') continue;
    symbolLookup.set(key, sym);
    
    const simpleName = key.split('.').pop()?.split(':')[0];
    if (simpleName && simpleName !== key && !symbolLookup.has(simpleName)) {
      symbolLookup.set(simpleName, sym);
    }
  }

  
  function traceChain(
    fnName:  string,
    visited: Set<string>,
    depth:   number
  ): string[] {
    if (depth > 12) return [`${fnName} (max depth)`];
    if (visited.has(fnName)) return [`${fnName} (cycle)`];

    visited.add(fnName);
    const symbol = symbolLookup.get(fnName);
    if (!symbol) return [fnName]; 

    const chain: string[] = [fnName];
    const calls: string[] = Array.isArray(symbol.calls) ? symbol.calls : [];

    for (const called of calls) {
      
      const calledName = called.split(':')[0].trim();
      if (!calledName || calledName === fnName) continue;
      chain.push(...traceChain(calledName, new Set(visited), depth + 1));
    }

    return chain;
  }


  const callFlowGraph: Record<string, any> = {};
  let traced = 0;
  const shallow: string[] = [];

  for (const [entryPoint, route] of Object.entries(apiGraph)) {
    if (entryPoint === '_sources' || !route || typeof route !== 'object') continue;

    const handler = typeof route.handler === 'string' ? route.handler : undefined;
    if (!handler) continue;

    const executionChain = traceChain(handler, new Set(), 0);


    const files = new Set<string>();
    for (const fn of executionChain) {
      const sym = symbolLookup.get(fn);
      if (sym?.file) files.add(sym.file);
    }

    if (files.size === 0) {
      shallow.push(entryPoint);
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

  
  let existingSources: string[] = [];
  try {
    if (await fs.pathExists(cfPath)) {
      const existing = await fs.readJson(cfPath);
      if (Array.isArray(existing._sources)) {
        existingSources = existing._sources;
      }
    }
  } catch {  }

  if (existingSources.length > 0) {
    callFlowGraph._sources = existingSources;
  }

  try {
    await fs.writeJson(cfPath, callFlowGraph, { spaces: 2 });
  } catch {

  }

  return { traced, shallow };
}

export async function computeMigrationOrder(modernPath: string): Promise<string[]> {
  const graphPath = path.join(modernPath, '_analysis', 'imports-graph.json');

  if (!(await fs.pathExists(graphPath))) return [];

  let graph: Record<string, any>;
  try {
    graph = normalizeGraphKeys(await fs.readJson(graphPath));
  } catch {
    return [];
  }

  const files = Object.keys(graph).filter(
    k => k !== '_sources' && graph[k] && typeof graph[k] === 'object'
  );
  const fileSet = new Set(files);

  // inDegree[f] = number of LOCAL files f imports that also exist as nodes in
  // the graph — i.e. how many of f's own dependencies must be migrated first.
  const inDegree   = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const f of files) {
    const imports: unknown[] = Array.isArray(graph[f].imports) ? graph[f].imports : [];
    const localDeps = imports
      .filter((i): i is string => typeof i === 'string')
      .map(i => resolveLocalImportPath(f, i))
      .filter(i => fileSet.has(i) && i !== f);

    inDegree.set(f, localDeps.length);
    for (const dep of localDeps) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(f);
    }
  }

  const fanInScore = (f: string): number => {
    const entry = graph[f];
    return typeof entry.dependencyScore === 'number'
      ? entry.dependencyScore
      : (Array.isArray(entry.importedBy) ? entry.importedBy.length : 0);
  };

  // Kahn's algorithm: only emit a file once every local file it imports has
  // already been emitted. Among files that are currently ready (in-degree 0),
  // prefer the one depended on by the most other files, so foundational
  // modules still surface early within their ready layer. If a dependency
  // cycle leaves nothing at in-degree 0, break it by picking the highest
  // fan-in file among what's left, so the sort always makes progress.
  const remaining = new Set(files);
  const order: string[] = [];

  while (remaining.size > 0) {
    let candidates = [...remaining].filter(f => (inDegree.get(f) ?? 0) === 0);
    if (candidates.length === 0) {
      candidates = [...remaining]; // cycle — force progress via fan-in
    }
    candidates.sort((a, b) => fanInScore(b) - fanInScore(a));

    const next = candidates[0];
    order.push(next);
    remaining.delete(next);

    for (const dep of dependents.get(next) ?? []) {
      if (remaining.has(dep)) {
        inDegree.set(dep, Math.max(0, (inDegree.get(dep) ?? 0) - 1));
      }
    }
  }

  return order;
}

// ── Graph-emptiness validation ──────────────────────────────────────────────
// Moved from planner-agent.ts — belongs here with the rest of the graph
// post-processing rather than the Stage-1 phase-sequencer.

export function isGraphEmpty(graphData: unknown): boolean {
  if (!graphData || typeof graphData !== 'object') return true;
  const obj = graphData as Record<string, unknown>;

  for (const val of Object.values(obj)) {
    if (Array.isArray(val)  && val.length > 0)        return false;
    if (typeof val === 'object' && val !== null && Object.keys(val as object).length > 0) return false;
    if (typeof val === 'string' && val.trim().length > 0) return false;
    if (typeof val === 'number' && val > 0)           return false;
  }
  return true;
}

// Checks the three primary Phase-2 graphs (symbol/entity/api) directly on disk.
// Used by the graph quality gate instead of the TOTAL_* counters, which do not
// exist until Pass C/D runs.
export async function arePrimaryGraphsEmpty(modernPath: string): Promise<boolean> {
  const graphsDir = path.join(modernPath, '_analysis');
  for (const name of ['symbol', 'entity', 'api']) {
    try {
      const raw  = await fs.readFile(path.join(graphsDir, `${name}-graph.json`), 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      const domainData = Object.fromEntries(
        Object.entries(data).filter(([k]) => k !== '_sources')
      );
      if (!isGraphEmpty(domainData)) return false;
    } catch {
      // missing or unreadable file counts as empty
    }
  }
  return true;
}

// Detects the specific corruption class confirmed in a real run: the
// imports-graph collapsing every file's entry into one bogus shared key
// (e.g. literally "imports", the graph's own domain name) instead of one
// real entry per file — which makes computeMigrationOrder() below see only
// ONE (fake) file to migrate, silently dropping every real one before
// Migration Planning ever runs.
//
// Deliberately NOT a self-check (imports-graph's own _sources vs its own
// entry count) — a file can legitimately be ABSENT from _sources entirely
// (e.g. a COBOL file with no local COPY/imports at all triggers the "skip
// this graph, don't call the tool with empty data" rule), which would make
// a self-check blind to that file being missing from BOTH sides at once.
// Compared instead against symbol-graph's _sources — a real, external,
// language-agnostic ground truth: almost every file (any language, COBOL
// included) yields at least one symbol/paragraph entry, even when it has
// zero local dependencies.
export async function checkImportsGraphSanity(modernPath: string): Promise<string | null> {
  const dir = path.join(modernPath, '_analysis');

  const readSources = async (name: string): Promise<string[]> => {
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, `${name}-graph.json`), 'utf-8'));
      return Array.isArray(data._sources) ? data._sources : [];
    } catch {
      return [];
    }
  };

  const symbolSources = await readSources('symbol');
  if (symbolSources.length === 0) return null; // nothing real to compare against yet

  let importsData: Record<string, unknown> = {};
  try {
    importsData = JSON.parse(await fs.readFile(path.join(dir, 'imports-graph.json'), 'utf-8'));
  } catch {
    return null; // missing entirely is a different, already-handled case (draftTasks.length === 0)
  }

  const realEntries = Object.keys(importsData).filter(k => k !== '_sources').length;

  if (realEntries < symbolSources.length * 0.5) {
    return `imports-graph looks incomplete: symbol-graph found ${symbolSources.length} real ` +
           `file(s), but imports-graph only has ${realEntries} real entr${realEntries === 1 ? 'y' : 'ies'}. ` +
           `Migration Planning may be missing real files as a result — check imports-graph.json ` +
           `for a bug like every file's data collapsing into one shared key instead of one per file.`;
  }
  return null;
}

export async function validateGraphResolverOutputs(
  modernPath: string,
  onLog?: LogFn
): Promise<void> {
  const graphsDir = path.join(modernPath, '_analysis');
  const checks = [
    { name: 'call-flow',    sectionRef: 'Section 14',   critical: true  },
    { name: 'architecture', sectionRef: 'Section 2',    critical: true  },
    { name: 'entity',       sectionRef: 'Section 5',    critical: false },
    { name: 'symbol',       sectionRef: 'Sections 7+8', critical: false },
    { name: 'api',          sectionRef: 'Section 10',   critical: false },
  ];

  onLog?.('[GraphValidator] Validating graph resolver outputs...', 'info');

  for (const check of checks) {
    const graphPath = path.join(graphsDir, `${check.name}-graph.json`);
    try {
      const raw  = await fs.readFile(graphPath, 'utf-8').catch(() => '{}');
      const data = JSON.parse(raw) as Record<string, unknown>;

      const realKeys = Object.keys(data).filter(k => k !== '_sources');

      const realEntries = realKeys.filter(k => {
        const v = data[k];
        if (Array.isArray(v))                                    return v.length > 0;
        if (v && typeof v === 'object') return Object.keys(v as object).length > 0;
        if (typeof v === 'string')                               return (v as string).trim().length > 0;
        return v !== null && v !== undefined;
      });
      if (realEntries.length === 0) {
        onLog?.(
          `[GraphValidator] ${check.name}-graph: ${realKeys.length} key(s) but 0 real data entries` +
          ` (hollow graph — only metadata or empty objects). ` +
          `${check.sectionRef} will use TypeScript fallback or "not applicable" note.` +
          (check.critical ? ' (CRITICAL — check agent logs for errors)' : ''),
          'warning'
        );
      } else {
        onLog?.(
          `[GraphValidator] ${check.name}-graph: ${realEntries.length} real entries. ${check.sectionRef} ready.`,
          'success'
        );
      }
    } catch {
      onLog?.(`[GraphValidator] Could not read ${check.name}-graph.json.`, 'warning');
    }
  }
}
