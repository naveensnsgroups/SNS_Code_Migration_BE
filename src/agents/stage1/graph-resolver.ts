

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

  
  for (const [key, entry] of Object.entries(graph)) {
    if (key === '_sources' || !entry || typeof entry !== 'object') continue;
    entry.importedBy = [];
  }

  
  for (const [filePath, entry] of Object.entries(graph)) {
    if (filePath === '_sources' || !entry || typeof entry !== 'object') continue;

    const imports: string[] = Array.isArray(entry.imports) ? entry.imports : [];
    for (const imported of imports) {
      if (!imported || imported === filePath) continue; 

      
      const normalised = imported.replace(/\\/g, '/');
      if (graph[normalised] && typeof graph[normalised] === 'object') {
        graph[normalised].importedBy = graph[normalised].importedBy ?? [];
        if (!graph[normalised].importedBy.includes(filePath)) {
          graph[normalised].importedBy.push(filePath);
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

  return traced;
}

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

  
  scored.sort((a, b) => b.score - a.score);

  
  return scored.slice(0, 50).map(e => e.path);
}
