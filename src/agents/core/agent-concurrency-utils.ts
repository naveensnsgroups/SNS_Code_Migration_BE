// Generic concurrency/heuristics helpers used by Stage 1's PlannerAgent —
// bounded-concurrency task running, a phase-level timeout wrapper, and the
// model-size-aware batching/turn-cap heuristics. None of this is specific to
// any one phase; it was previously bolted onto planner-agent.ts alongside the
// actual phase-sequencing logic.

export type LogFn = (msg: string, lvl?: 'info' | 'success' | 'error' | 'warning') => void;

export function computeTurnCapFromData(
  contextK:         number,
  avgFileSizeLines: number,
  pendingCount:     number
): number {
  if (contextK <= 0 || avgFileSizeLines <= 0) return Math.min(22, pendingCount);
  const tokenBudget   = contextK * 1000 * 0.55;
  const tokensPerFile = Math.max(avgFileSizeLines * 4 + 500, 700);
  const contextBased  = Math.floor(tokenBudget / tokensPerFile);

  return Math.min(Math.max(contextBased, 3), pendingCount);
}

export function computeBatchSizeFromData(pendingCount: number): number {
  if (pendingCount < 30)  return 10;
  if (pendingCount < 100) return 8;
  if (pendingCount < 300) return 5;
  return 3;
}

export function computeAvgFileSizeLines(fileIndex: any[]): number {
  if (!fileIndex.length) return 150;
  const total = fileIndex.reduce((sum: number, f: any) => sum + (f?.estimatedLines ?? 0), 0);
  const avg   = Math.round(total / fileIndex.length);
  return avg > 0 ? avg : 150;
}

export function getModelContextK(modelName: string): number {
  const m = (modelName ?? '').toLowerCase();

  if (m.includes('gemini-2.5-pro'))    return 1000;
  if (m.includes('gemini-2.5-flash'))  return 1000;
  if (m.includes('gemini-2.0-flash'))  return 1000;
  if (m.includes('gemini-1.5-pro'))    return 1000;
  if (m.includes('gemini-1.5-flash'))  return 1000;

  if (m.includes('claude-3-5-sonnet')) return 200;
  if (m.includes('claude-sonnet-4'))   return 200;
  if (m.includes('claude-opus-4'))     return 200;
  if (m.includes('claude-3-opus'))     return 200;
  if (m.includes('claude-haiku'))      return 200;
  if (m.includes('claude-3-haiku'))    return 200;

  if (m.includes('gpt-4o'))            return 128;
  if (m.includes('gpt-4-turbo'))       return 128;
  if (m.includes('gpt-3.5'))           return 16;

  return 128;
}

export function computeMaxConcurrentSections(modelName: string): number {
  const m = (modelName ?? '').toLowerCase().trim();

  if (m.startsWith('gemini-') || m.includes('gemini')) {
    if (m.includes('pro'))   return 2;
    if (m.includes('flash')) return 4;
    return 3;
  }

  if (m.startsWith('claude-') || m.includes('claude')) {
    if (m.includes('opus'))   return 3;
    if (m.includes('haiku'))  return 8;
    return 5;
  }

  if (m.startsWith('gpt-') || m.includes('gpt')) return 4;

  if (m.startsWith('groq-') || m.includes('groq')) return 6;
  return 3;
}

export async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < tasks.length; i++) {
    const idx  = i;
    const task = tasks[idx];
    const p: Promise<void> = task()
      .then(r  => { results[idx] = { status: 'fulfilled', value: r }; })
      .catch(e => { results[idx] = { status: 'rejected',  reason: e }; })
      .finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
  return results;
}

export function withPhaseTimeout<T>(
  operation:   Promise<T>,
  timeoutMs:   number,
  phaseLabel:  string,
  onLog?:      LogFn
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onLog?.(
        `[PlannerAgent] ⏱ TIMEOUT: ${phaseLabel} exceeded ${Math.round(timeoutMs / 60_000)} min. ` +
        `Pipeline will resume from the last saved phase on next run.`,
        'error'
      );
      reject(new Error(
        `[PlannerAgent] Phase timeout: "${phaseLabel}" did not complete within ` +
        `${Math.round(timeoutMs / 60_000)} minutes. ` +
        `active_phase has been saved — restart the pipeline to resume from this phase.`
      ));
    }, timeoutMs);

    operation
      .then(result => { clearTimeout(timer); resolve(result); })
      .catch(err   => { clearTimeout(timer); reject(err);    });
  });
}
