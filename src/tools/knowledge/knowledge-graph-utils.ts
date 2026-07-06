

export type GraphData = Record<string, any>;

const ENTITY_INDEXED_GRAPHS = new Set([
  'entity',       
  'symbol',       
  'api',          
  'db',           
  'event',        
  'config',       
  'state',        
  'async',        
  'integration',  
  'job',          
  'call-flow',    
  'imports',      
]);

const ARRAY_APPEND_GRAPHS = new Set([
  'rule',         
  'transform',    
  'test',         
]);

const DEEP_MERGE_GRAPHS = new Set([
  'security',     
  'architecture', 
  'middleware',   
  'error',        
]);

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
  
  return deepMergeObjects(existing, incoming);
}

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
      
      result[field] = value;
    }
  }
  return result;
}

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

// Canonical, key-order-independent serialization for dedup. Without deep key
// sorting, two logically-identical entries whose object keys were emitted in a
// different order (common LLM non-determinism) serialize differently and slip
// past dedup — inflating rule/transform/test graphs and skewing the counts that
// drive the Section 26 Risk Scorecard.
function canonicalStringify(val: unknown): string {
  if (Array.isArray(val)) return `[${val.map(canonicalStringify).join(',')}]`;
  if (val !== null && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const body = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(val);
}

function deduplicatedAppend(existing: any[], incoming: any[]): any[] {
  const seen = new Set(existing.map((x) => canonicalStringify(x)));
  const newItems: any[] = [];
  for (const item of incoming) {
    const key = canonicalStringify(item);
    if (seen.has(key)) continue;
    seen.add(key); // also dedup within the incoming batch itself
    newItems.push(item);
  }
  return [...existing, ...newItems];
}

export function getValidGraphNames(): string[] {
  return [
    ...Array.from(ENTITY_INDEXED_GRAPHS),
    ...Array.from(ARRAY_APPEND_GRAPHS),
    ...Array.from(DEEP_MERGE_GRAPHS),
  ];
}
