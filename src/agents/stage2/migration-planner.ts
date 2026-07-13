

import fs   from 'fs-extra';
import path from 'path';
import { computeMigrationOrder, resolveLocalImportPath, normalizeGraphKeys } from '../stage1/graph-resolver.js';

export interface DraftMigrationTask {
  legacyFile:    string;
  rulesInvolved: string[];   // rule-graph descriptions whose relatedFiles include this file
  dependsOn:     string[];   // other legacyFile paths that must be migrated first
}

// Everything here is deterministic — no LLM call. dependsOn and rulesInvolved
// are both already fully computable from Stage 1's graphs (imports-graph edges,
// rule-graph relatedFiles), so there is nothing for a model to "decide" about
// them — asking an LLM to reconstruct data that already exists in the graphs
// verbatim would only add cost and a chance to get it wrong.
export async function buildDraftMigrationTasks(modernPath: string): Promise<DraftMigrationTask[]> {
  const analysisDir  = path.join(modernPath, '_analysis');
  const importsPath  = path.join(analysisDir, 'imports-graph.json');
  const rulePath     = path.join(analysisDir, 'rule-graph.json');

  const migrationOrder = await computeMigrationOrder(modernPath);
  if (migrationOrder.length === 0) return [];

  let importsGraph: Record<string, any> = {};
  if (await fs.pathExists(importsPath)) {
    try { importsGraph = normalizeGraphKeys(await fs.readJson(importsPath)); } catch { /* treat as empty */ }
  }

  let ruleGraph: Record<string, any> = {};
  if (await fs.pathExists(rulePath)) {
    try { ruleGraph = await fs.readJson(rulePath); } catch { /* treat as empty */ }
  }

  const orderedSet = new Set(migrationOrder);

  // file -> [rule descriptions] reverse index, built from each rule's relatedFiles.
  const rulesByFile = new Map<string, string[]>();
  for (const [domain, rules] of Object.entries(ruleGraph)) {
    if (domain === '_sources' || !Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') continue;
      const desc = typeof rule.rule === 'string' ? rule.rule : undefined;
      const relatedFiles: string[] = Array.isArray(rule.relatedFiles) ? rule.relatedFiles : [];
      if (!desc) continue;
      for (const file of relatedFiles) {
        if (!orderedSet.has(file)) continue;
        if (!rulesByFile.has(file)) rulesByFile.set(file, []);
        rulesByFile.get(file)!.push(desc);
      }
    }
  }

  return migrationOrder.map((legacyFile): DraftMigrationTask => {
    const entry = importsGraph[legacyFile];
    const imports: unknown[] = Array.isArray(entry?.imports) ? entry.imports : [];
    const dependsOn = imports
      .filter((i): i is string => typeof i === 'string')
      .map(i => resolveLocalImportPath(legacyFile, i))
      .filter(i => orderedSet.has(i) && i !== legacyFile);

    return {
      legacyFile,
      rulesInvolved: rulesByFile.get(legacyFile) ?? [],
      dependsOn,
    };
  });
}
