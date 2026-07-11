// Small pieces shared across the three Stage-2 sub-stage runners
// (migration-planning-runner.ts, code-generation-runner.ts, verification-runner.ts).

export type LogFn = (msg: string, lvl?: 'info' | 'success' | 'error' | 'warning') => void;

export const PLANNING_BATCH_TIMEOUT_MS = 8 * 60_000;
export const GENERATION_TIMEOUT_MS     = 8 * 60_000;
export const RULE_CHECK_TIMEOUT_MS     = 5 * 60_000;
export const BUILD_CHECK_TIMEOUT_MS    = 10 * 60_000;

export function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[MigrationAgent] "${label}" did not complete within ${Math.round(timeoutMs / 60_000)} min.`));
    }, timeoutMs);
    operation
      .then(result => { clearTimeout(timer); resolve(result); })
      .catch(err   => { clearTimeout(timer); reject(err);    });
  });
}

// Case-insensitive substrings that indicate the model wrote a description of
// what the code should do instead of the code itself — the exact failure mode
// found in a real run (a route file whose handlers were literal comments plus
// a hardcoded placeholder response, and an entrypoint that commented out its
// router registrations "for a future step" even though those routers already
// existed on disk). A file exists check alone cannot catch this — the file
// really was written, just not with real logic.
const STUB_MARKERS = [
  'implementation would go here',
  'would go here',
  'assuming these will be',
  'assuming this will be',
  'will be translated in subsequent steps',
  'in a real migration',
  'to be implemented',
  'not yet implemented',
  'todo: implement',
  'placeholder for',
];

export function findStubMarker(content: string): string | null {
  const lower = content.toLowerCase();
  for (const marker of STUB_MARKERS) {
    if (lower.includes(marker)) return marker;
  }
  return null;
}

export function guessExtension(targetLanguage: string): string {
  const lang = (targetLanguage || '').toLowerCase();
  if (lang.includes('typescript')) return '.ts';
  if (lang.includes('javascript')) return '.js';
  if (lang.includes('python'))     return '.py';
  if (lang.includes('java') && !lang.includes('javascript')) return '.java';
  if (lang.includes('c#') || lang.includes('csharp')) return '.cs';
  if (lang.includes('go'))         return '.go';
  if (lang.includes('rust'))       return '.rs';
  if (lang.includes('ruby'))       return '.rb';
  if (lang.includes('php'))        return '.php';
  if (lang.includes('kotlin'))     return '.kt';
  return '.txt'; // unknown target language — safest inert fallback, never invented
}

export function withExtension(filePath: string, ext: string): string {
  const dot = filePath.lastIndexOf('.');
  const base = dot > filePath.lastIndexOf('/') ? filePath.slice(0, dot) : filePath;
  return `${base}${ext}`;
}
