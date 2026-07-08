

import path from 'path';
import fs   from 'fs-extra';

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
  if (normalized.length > 1 && normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.startsWith('./') || normalized.startsWith('../')) {
    const importingDir = path.posix.dirname(importingFile.replace(/\\/g, '/'));
    normalized = path.posix.normalize(path.posix.join(importingDir, normalized));
  }
  return normalized;
}

// Strips a stray leading+trailing literal quote pair from every top-level key
// of a graph object (see the sanitization note in append-to-knowledge-graph.tool.ts).
// Applied on READ so graphs written before that fix existed self-heal on the
// next resolver pass, instead of staying permanently broken.
export function normalizeGraphKeys(graph: Record<string, any>): Record<string, any> {
  const normalized: Record<string, any> = {};
  for (const [key, value] of Object.entries(graph)) {
    const cleanKey = key.length > 1 && key.startsWith('"') && key.endsWith('"')
      ? key.slice(1, -1)
      : key;
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
