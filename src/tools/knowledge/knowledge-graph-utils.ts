// =============================================================================
//  tools/knowledge/knowledge-graph-utils.ts
//  Merge strategies for the 18 named knowledge graphs.
//  Each graph has a specific shape — the merge strategy preserves that shape
//  while combining data accumulated across many file reads.
// =============================================================================

export type GraphData = Record<string, any>;

// ── Graph Strategy Classification ────────────────────────────────────────────

/**
 * ENTITY_INDEXED: top-level keys are entity/symbol/endpoint names.
 * Merge strategy: for each key, merge the sub-object fields.
 * Arrays inside sub-objects are appended (deduplicated).
 */
const ENTITY_INDEXED_GRAPHS = new Set([
  'entity',       // { "User": { table, files, fields, relations, ... } }
  'symbol',       // { "createUser": { file, signature, calledBy, calls, ... } }
  'api',          // { "POST /users": { handler, auth, request, responses, ... } }
  'db',           // { "users": { operations:[...], repositoryFile, ... } }
  'event',        // { "user.created": { emittedIn, payload, listeners:[...] } }
  'config',       // { "DB_URL": { type, required, default, usedIn:[...] } }
  'state',        // { "Order": { field, states:[...], transitions:[...] } }
  'async',        // { "createUser": { pattern, awaits:[...], ... } }
  'integration',  // { "Stripe": { purpose, auth, operations:[...] } }
  'job',          // { "Daily Report": { schedule, implementation, ... } }
  'call-flow',    // { "POST /users": { steps:[...] } }
]);

/**
 * ARRAY_APPEND: top-level keys map to arrays of items.
 * Merge strategy: append new items to each domain array.
 */
const ARRAY_APPEND_GRAPHS = new Set([
  'rule',         // { "auth": [...rules], "validation": [...rules] }
  'transform',    // { "User Transform": { inputShape, outputShape, ... } }
  'test',         // { framework, testFiles: { "path": { cases:[...] } } }
]);

/**
 * DEEP_MERGE: complex nested objects, merged recursively.
 * Merge strategy: deep recursive merge, arrays deduplicated.
 */
const DEEP_MERGE_GRAPHS = new Set([
  'security',     // { authMechanism, tokenStrategy, roles, publicRoutes, ... }
  'architecture', // { type, layers, patterns, modules, ... }
  'middleware',   // { globalPipeline:[...], routeSpecific:{}, registrationFile }
  'error',        // { customErrors:{}, globalHandler:{} }
]);

// ── Main Merge Entry Point ─────────────────────────────────────────────────────

/**
 * Merges `incoming` data into the `existing` graph using the strategy
 * appropriate for `graphName`. Always returns a new merged object (no mutation).
 */
export function mergeGraphData(
  graphName: string,
  existing: GraphData,
  incoming: GraphData
): GraphData {
  if (ENTITY_INDEXED_GRAPHS.has(graphName)) {
    return mergeEntityIndexed(existing, incoming);
  }
  if (ARRAY_APPEND_GRAPHS.has(graphName)) {
    return mergeArrayAppend(existing, incoming);
  }
  // deep merge (security, architecture, middleware, error, or unknown graph)
  return deepMergeObjects(existing, incoming);
}

// ── Entity-Indexed Strategy ───────────────────────────────────────────────────

/**
 * Merges by entity key. Each key in `incoming` is merged with the matching
 * key in `existing`. New keys are added as-is.
 */
function mergeEntityIndexed(existing: GraphData, incoming: GraphData): GraphData {
  const result: GraphData = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (
      result[key] !== undefined &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = mergeEntityFields(result[key] as GraphData, value as GraphData);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Merges two entity sub-objects. Arrays are appended (deduplicated by JSON).
 * Nested objects are deep-merged. Scalar values are overwritten by incoming.
 */
function mergeEntityFields(existing: GraphData, incoming: GraphData): GraphData {
  const result: GraphData = { ...existing };
  for (const [field, value] of Object.entries(incoming)) {
    if (Array.isArray(value) && Array.isArray(result[field])) {
      result[field] = deduplicatedAppend(result[field] as any[], value as any[]);
    } else if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[field] !== null &&
      typeof result[field] === 'object' &&
      !Array.isArray(result[field])
    ) {
      result[field] = deepMergeObjects(result[field] as GraphData, value as GraphData);
    } else {
      // Scalar: incoming wins. Preserves latest data (e.g. updated file path).
      result[field] = value;
    }
  }
  return result;
}

// ── Array-Append Strategy ─────────────────────────────────────────────────────

/**
 * For array-valued keys (e.g. rule domains), appends incoming items.
 * For object-valued keys (e.g. testFiles), deep-merges.
 */
function mergeArrayAppend(existing: GraphData, incoming: GraphData): GraphData {
  const result: GraphData = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (Array.isArray(value)) {
      result[key] = [...(Array.isArray(result[key]) ? result[key] : []), ...value];
    } else if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMergeObjects(result[key] as GraphData, value as GraphData);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Deep Merge Strategy ───────────────────────────────────────────────────────

/**
 * Recursively merges `source` into `target`. Arrays are deduplicated-appended.
 * Nested objects are recursively merged. Scalars: source wins.
 */
export function deepMergeObjects(target: GraphData, source: GraphData): GraphData {
  const result: GraphData = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value) && Array.isArray(result[key])) {
      result[key] = deduplicatedAppend(result[key] as any[], value as any[]);
    } else if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMergeObjects(result[key] as GraphData, value as GraphData);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Appends items from `incoming` to `existing`, skipping exact duplicates
 * (compared by JSON stringification).
 */
function deduplicatedAppend(existing: any[], incoming: any[]): any[] {
  const seen = new Set(existing.map((x) => JSON.stringify(x)));
  const newItems = incoming.filter((item) => !seen.has(JSON.stringify(item)));
  return [...existing, ...newItems];
}

/**
 * Returns the list of valid graph names for validation.
 */
export function getValidGraphNames(): string[] {
  return [
    ...Array.from(ENTITY_INDEXED_GRAPHS),
    ...Array.from(ARRAY_APPEND_GRAPHS),
    ...Array.from(DEEP_MERGE_GRAPHS),
  ];
}
