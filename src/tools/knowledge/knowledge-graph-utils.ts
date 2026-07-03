

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

function deduplicatedAppend(existing: any[], incoming: any[]): any[] {
  const seen = new Set(existing.map((x) => JSON.stringify(x)));
  const newItems = incoming.filter((item) => !seen.has(JSON.stringify(item)));
  return [...existing, ...newItems];
}

export function getValidGraphNames(): string[] {
  return [
    ...Array.from(ENTITY_INDEXED_GRAPHS),
    ...Array.from(ARRAY_APPEND_GRAPHS),
    ...Array.from(DEEP_MERGE_GRAPHS),
  ];
}
