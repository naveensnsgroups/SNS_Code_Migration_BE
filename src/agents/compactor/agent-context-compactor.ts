

import { LanguageModelMessage, TextMessage } from '../../types/language-model.js';

const COMPACTION_BUDGET_RATIO = 0.60;   
const KEEP_RECENT_CHARS       = 40_000; 

const PROVIDER_CHAR_BUDGET: Record<string, number> = {
  gemini:  1_000_000 * 4 * COMPACTION_BUDGET_RATIO, 
  claude:    200_000 * 4 * COMPACTION_BUDGET_RATIO, 
  gpt:       128_000 * 4 * COMPACTION_BUDGET_RATIO, 
  groq:      128_000 * 4 * COMPACTION_BUDGET_RATIO, 
  default:   128_000 * 4 * COMPACTION_BUDGET_RATIO, 
};

export function resolveCompactionCharBudget(modelName: string): number {
  const m = (modelName ?? '').toLowerCase().trim();
  if (m.startsWith('gemini-') || m.includes('gemini')) return PROVIDER_CHAR_BUDGET.gemini;
  if (m.startsWith('claude-') || m.includes('claude')) return PROVIDER_CHAR_BUDGET.claude;
  if (m.startsWith('gpt-')    || m.includes('gpt'))    return PROVIDER_CHAR_BUDGET.gpt;
  if (m.startsWith('groq-')   || m.includes('groq'))   return PROVIDER_CHAR_BUDGET.groq;
  return PROVIDER_CHAR_BUDGET.default;
}

export function estimateContextChars(msgs: LanguageModelMessage[]): number {
  return msgs.reduce((sum, m) => {
    if ('text' in m    && m.text)    return sum + (m.text as string).length;
    if ('content' in m && m.content) return sum + JSON.stringify(m.content).length;
    if ('input' in m   && m.input)   return sum + JSON.stringify(m.input).length;
    return sum + 64; 
  }, 0);
}

export function compactMessagesIfNeeded(
  messages:  LanguageModelMessage[],
  budget:    number,
  iteration: number,
  onLog?:    (msg: string, lvl?: 'info' | 'success' | 'error' | 'warning') => void
): boolean {
  const currentChars = estimateContextChars(messages);

  
  if (currentChars <= budget || messages.length <= 2) return false;

  const head = messages.slice(0, 2); 
  const tail: LanguageModelMessage[] = [];
  let   tailChars = 0;

  
  for (let i = messages.length - 1; i >= 2; i--) {
    const m = messages[i];
    const c = 'text' in m    && m.text    ? (m.text as string).length
            : 'content' in m && m.content ? JSON.stringify(m.content).length
            : 'input' in m   && m.input   ? JSON.stringify(m.input).length
            : 64;
    if (tailChars + c > KEEP_RECENT_CHARS) break;
    tail.unshift(m);
    tailChars += c;
  }

  const before = messages.length;
  messages.splice(0, messages.length, ...head, ...tail);

  
  
  
  
  
  
  messages.push({
    actor: 'user',
    type:  'text',
    text:
      `[SYSTEM: Context window compacted — ${before - messages.length} stale conversation turns removed to free context space. ` +
      `Your analysis work is NOT lost — all extracted data was written to knowledge graph files on disk. ` +
      `To resume: call get_task_context to check LAST_FILE_ANALYZED, then continue processing ` +
      `the next PENDING file from FILE_INDEX. Do not restart from the beginning.]`,
  } as TextMessage);

  onLog?.(
    `[ContextCompactor] Turn ${iteration}: ` +
    `${Math.round(currentChars / 1000)}K chars > ${Math.round(budget / 1000)}K budget. ` +
    `Compacted ${before} → ${messages.length - 1} messages ` +
    `(kept last ${Math.round(tailChars / 1000)}K chars of history + injected context bridge).`,
    'info'
  );

  return true;
}
