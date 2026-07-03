

export type DomainBucket = 'DATA' | 'BACKEND' | 'LOGIC' | 'INFRA' | 'UI';

export interface FileEntry {
  path:           string;
  type:           string;  
  role:           string;  
  estimatedLines: number;
  read_status:    string;  
}

export type DomainBuckets = Record<DomainBucket, FileEntry[]>;

export function routeFilesToDomains(fileIndex: FileEntry[]): DomainBuckets {
  const buckets: DomainBuckets = {
    DATA: [], BACKEND: [], LOGIC: [], INFRA: [], UI: [],
  };

  for (const file of fileIndex) {
    
    if (file.read_status === 'DONE' || file.read_status === 'PARTIAL' || file.read_status === 'PROBLEMATIC') {
      continue;
    }
    
    if (file.type !== 'source' && file.type !== 'schema') {
      continue;
    }

    const bucket = classifyFile(file);
    buckets[bucket].push(file);
  }

  return buckets;
}

function classifyFile(file: FileEntry): DomainBucket {
  const p = file.path.toLowerCase();
  const r = (file.role ?? '').toLowerCase();
  const ext = p.split('.').pop() ?? '';

  
  
  if (
    ext === 'vue' || ext === 'svelte' ||
    (ext === 'jsx' || ext === 'tsx') ||
    p.includes('/component') || p.includes('/components/') ||
    p.includes('/page') || p.includes('/pages/') ||
    p.includes('/view') || p.includes('/views/') ||
    p.includes('/screen') || p.includes('/screens/') ||
    p.includes('/widget') || p.includes('/widgets/') ||
    r.includes('component') || r.includes('page') ||
    r.includes('view') || r.includes('hook') || r.includes('store') ||
    r.includes('widget') || r.includes('screen')
  ) {
    return 'UI';
  }

  
  
  if (
    r.includes('controller') || r.includes('route') || r.includes('router') ||
    r.includes('middleware') || r.includes('guard') || r.includes('filter') ||
    r.includes('interceptor') || r.includes('handler') || r.includes('resolver') ||
    p.includes('/controller') || p.includes('/controllers/') ||
    p.includes('/route') || p.includes('/routes/') ||
    p.includes('/middleware') || p.includes('/guard') ||
    p.includes('/filter') || p.includes('/interceptor') ||
    p.includes('/graphql/resolver') || p.includes('/grpc/')
  ) {
    return 'BACKEND';
  }

  
  
  if (
    file.type === 'schema' ||
    ext === 'prisma' ||
    r.includes('entity') || r.includes('model') || r.includes('schema') ||
    r.includes('dto') || r.includes('migration') || r.includes('repository') ||
    r.includes('seed') || r.includes('fixture') ||
    p.includes('/entity') || p.includes('/entities/') ||
    p.includes('/model') || p.includes('/models/') ||
    p.includes('/schema') || p.includes('/schemas/') ||
    p.includes('/dto') || p.includes('/dtos/') ||
    p.includes('/migration') || p.includes('/migrations/') ||
    p.includes('/repository') || p.includes('/repositories/') ||
    p.includes('/seed') || p.includes('/fixture')
  ) {
    return 'DATA';
  }

  
  
  if (
    file.type === 'config' || file.type === 'test' ||
    r.includes('job') || r.includes('worker') || r.includes('cron') ||
    r.includes('scheduler') || r.includes('queue') || r.includes('consumer') ||
    r.includes('integration') || r.includes('client') || r.includes('sdk') ||
    r.includes('adapter') || r.includes('provider') ||
    p.includes('/job') || p.includes('/jobs/') ||
    p.includes('/worker') || p.includes('/workers/') ||
    p.includes('/queue') || p.includes('/consumer') ||
    p.includes('/integration') || p.includes('/integrations/') ||
    p.endsWith('.spec.ts') || p.endsWith('.spec.js') ||
    p.endsWith('.test.ts') || p.endsWith('.test.js') ||
    p.endsWith('_test.go') || p.endsWith('_spec.rb') ||
    p.endsWith('Test.java') || p.endsWith('Tests.cs') ||
    p.includes('/test/') || p.includes('/tests/') ||
    p.includes('/spec/') || p.includes('/__tests__/')
  ) {
    return 'INFRA';
  }

  
  
  return 'LOGIC';
}

export function deduplicateFileIndex(fileIndex: FileEntry[]): { deduped: FileEntry[]; removedCount: number } {
  const seen = new Map<string, FileEntry>();
  let removedCount = 0;

  for (const entry of fileIndex) {
    const existing = seen.get(entry.path);
    if (!existing) {
      seen.set(entry.path, { ...entry });
    } else {
      removedCount++;
      
      const statusPriority = { DONE: 3, PARTIAL: 2, PROBLEMATIC: 1, PENDING: 0 };
      const existingPriority = statusPriority[existing.read_status as keyof typeof statusPriority] ?? 0;
      const newPriority      = statusPriority[entry.read_status  as keyof typeof statusPriority] ?? 0;
      if (newPriority > existingPriority) {
        seen.set(entry.path, { ...entry });
      }
    }
  }

  return { deduped: [...seen.values()], removedCount };
}

export function getBucketSummary(buckets: DomainBuckets): string {
  return Object.entries(buckets)
    .filter(([, files]) => files.length > 0)
    .map(([domain, files]) => `${domain}:${files.length}`)
    .join(' | ');
}
