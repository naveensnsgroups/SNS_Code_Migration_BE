

export interface AgentLoopConfig {
  
  maxIterations: number;

  
  
  
  
  reasoningLoopThreshold: number;  
  reasoningLoopSnippet:   number;  

  
  
  
  stuckToolWindow:    number;  
  stuckToolMaxErrors: number;  

  
  
  
  
  fingerprintWindow:   number;  
  fingerprintMaxDupes: number;  




  noProgressMaxTurns: number;

  // Max consecutive SUCCESSFUL bookkeeping-only tool calls (get/edit task context,
  // todoWrite, dashboard) with no productive work (file read / graph write) in
  // between, before the orchestrator nudges the agent to do real work or stop.
  // Closes the blind spot where an agent spins on successful edit_task_context
  // calls — invisible to the error-based and duplicate-based detectors.
  bookkeepingStreakMax: number;
}

// Tools that only mutate/read pipeline state — they do NOT advance the analysis.
// A run consisting only of these is spinning, not progressing.
export const BOOKKEEPING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'get_task_context',
  'edit_task_context',
  'todoWrite',
  'update-migration-dashboard',
  'compress-migration-context',
]);

const FAMILY_LOOP_CONFIGS: Record<string, AgentLoopConfig> = {

  
  
  'gemini-lite': {
    maxIterations:          10_000,
    reasoningLoopThreshold:  5_000, 
    reasoningLoopSnippet:    1_000,
    stuckToolWindow:             3,
    stuckToolMaxErrors:          3,
    fingerprintWindow:           6,
    fingerprintMaxDupes:         2,
    noProgressMaxTurns:          3,
    bookkeepingStreakMax:      6,
  },

  
  'gemini': {
    maxIterations:          10_000,
    reasoningLoopThreshold: 10_000,
    reasoningLoopSnippet:    1_500,
    stuckToolWindow:             3,
    stuckToolMaxErrors:          3,
    fingerprintWindow:           6,
    fingerprintMaxDupes:         2,
    noProgressMaxTurns:          3,
    bookkeepingStreakMax:      6,
  },

  
  
  'claude': {
    maxIterations:          10_000,
    reasoningLoopThreshold: 15_000, 
    reasoningLoopSnippet:    2_000,
    stuckToolWindow:             3,
    stuckToolMaxErrors:          2, 
    fingerprintWindow:           4,
    fingerprintMaxDupes:         1, 
    noProgressMaxTurns:          2,
    bookkeepingStreakMax:      6,
  },

  
  'gpt': {
    maxIterations:          10_000,
    reasoningLoopThreshold: 10_000,
    reasoningLoopSnippet:    1_500,
    stuckToolWindow:             3,
    stuckToolMaxErrors:          3,
    fingerprintWindow:           6,
    fingerprintMaxDupes:         2,
    noProgressMaxTurns:          3,
    bookkeepingStreakMax:      6,
  },

  
  'groq': {
    maxIterations:          10_000,
    reasoningLoopThreshold:  8_000, 
    reasoningLoopSnippet:    1_500,
    stuckToolWindow:             3,
    stuckToolMaxErrors:          3,
    fingerprintWindow:           6,
    fingerprintMaxDupes:         2,
    noProgressMaxTurns:          3,
    bookkeepingStreakMax:      6,
  },

  
  
  
  'mistral': {
    maxIterations:          10_000,
    reasoningLoopThreshold:  9_000,
    reasoningLoopSnippet:    1_500,
    stuckToolWindow:             3,
    stuckToolMaxErrors:          3,
    fingerprintWindow:           6,
    fingerprintMaxDupes:         2,
    noProgressMaxTurns:          3,
    bookkeepingStreakMax:      6,
  },

  
  'default': {
    maxIterations:          10_000,
    reasoningLoopThreshold: 10_000,
    reasoningLoopSnippet:    1_500,
    stuckToolWindow:             3,
    stuckToolMaxErrors:          3,
    fingerprintWindow:           6,
    fingerprintMaxDupes:         2,
    noProgressMaxTurns:          3,
    bookkeepingStreakMax:      6,
  },
};

export function resolveLoopConfig(modelName: string): AgentLoopConfig {
  const m = (modelName ?? '').toLowerCase().trim();
  if (m.includes('flash-lite'))                        return FAMILY_LOOP_CONFIGS['gemini-lite'];
  if (m.startsWith('gemini-') || m.includes('gemini')) return FAMILY_LOOP_CONFIGS['gemini'];
  if (m.startsWith('claude-') || m.includes('claude')) return FAMILY_LOOP_CONFIGS['claude'];
  if (m.startsWith('gpt-')    || m.includes('gpt'))    return FAMILY_LOOP_CONFIGS['gpt'];
  if (m.startsWith('groq-')   || m.includes('groq'))   return FAMILY_LOOP_CONFIGS['groq'];
  if (m.includes('mistral')   || m.includes('codestral') || m.includes('ministral') || m.includes('devstral')) return FAMILY_LOOP_CONFIGS['mistral'];
  return FAMILY_LOOP_CONFIGS['default'];
}

export type AgentLoopErrorType =
  | 'empty-data'        
  | 'duplicate-blocked' 
  | 'config-error'      
  | 'tool-not-found'    
  | 'stuck-tool'
  | 'reasoning-loop'
  | 'no-progress'
  | 'bookkeeping-loop'
  | 'rate-limit'
  | 'unknown';

const ERROR_SIGNATURES: ReadonlyArray<[string, AgentLoopErrorType]> = [
  ['EMPTY DATA REJECTED',  'empty-data'],
  ['DUPLICATE CALL BLOCKED','duplicate-blocked'],
  ['modernPath not set',   'config-error'],
  ['not initialized',      'config-error'],
  ['Path must be a string','config-error'],
  ['not registered',       'tool-not-found'],
  ['unknown tool',         'tool-not-found'],
  ['rate limit',           'rate-limit'],
  ['429',                  'rate-limit'],
  ['quota exceeded',       'rate-limit'],
  ['resource exhausted',   'rate-limit'],
  ['too many requests',    'rate-limit'],
];

export function classifyToolError(errorText: string): AgentLoopErrorType {
  const lower = (errorText ?? '').toLowerCase();
  for (const [signature, type] of ERROR_SIGNATURES) {
    if (lower.includes(signature.toLowerCase())) return type;
  }
  return 'unknown';
}

export interface LoopState {

  toolCallFingerprints: string[];

  noProgressTurns: number;

  // Consecutive successful bookkeeping-only tool calls since the last productive
  // (file-read / graph-write) action. Reset by any productive tool.
  bookkeepingStreak: number;
}

export function createLoopState(): LoopState {
  return {
    toolCallFingerprints: [],
    noProgressTurns: 0,
    bookkeepingStreak: 0,
  };
}

export function resetStateForErrorType(state: LoopState, errorType: AgentLoopErrorType): void {
  switch (errorType) {
    case 'stuck-tool':
      state.toolCallFingerprints = [];
      state.noProgressTurns      = 0;
      break;
    case 'reasoning-loop':
      
      state.noProgressTurns = 0;
      break;
    case 'no-progress':
      state.toolCallFingerprints = [];
      state.noProgressTurns      = 0;
      break;
    case 'bookkeeping-loop':
      state.bookkeepingStreak = 0;
      break;
    case 'config-error':
      state.toolCallFingerprints = [];
      state.noProgressTurns      = 0;
      break;
    case 'duplicate-blocked':
      
      
      break;
    default:
      
      break;
  }
}

export function buildRecoveryMessage(
  errorType: AgentLoopErrorType,
  toolName:  string,
  config:    AgentLoopConfig,
  extra?:    { turnChars?: number }
): string {
  switch (errorType) {

    case 'stuck-tool':
      return (
        `[ORCHESTRATOR INTERVENTION] Tool "${toolName}" returned an error ` +
        `${config.stuckToolMaxErrors} consecutive times. You are stuck. ` +
        `STOP calling "${toolName}" for the current file. ` +
        `Mark the current file DONE: set read_status="DONE" inside the FILE_INDEX array ` +
        `and re-save via edit_task_context. Then move to the next PENDING file.`
      );

    case 'reasoning-loop':
      return (
        `[ORCHESTRATOR INTERVENTION] You generated ` +
        `${Math.round((extra?.turnChars ?? 0) / 1_000)}K characters of planning text ` +
        `("Wait, I need to execute step...") but called NO tools. ` +
        `You are stuck in a reasoning loop. STOP WRITING PLANNING TEXT. ` +
        `NOW call the tools: ` +
        `(1) append-to-knowledge-graph for files with real extracted data. ` +
        `(2) edit_task_context to mark each file DONE (read_status="DONE" in file-index array). ` +
        `Do not write "Wait, I need to..." text. Just call the tools.`
      );

    case 'no-progress':
      return (
        `[ORCHESTRATOR INTERVENTION] ${config.noProgressMaxTurns} consecutive turns had ALL ` +
        `tools return errors. Zero state change. EMERGENCY RECOVERY: ` +
        `(1) Call get_task_context() with NO key parameter — get FILE_INDEX_KEY value and LAST_FILE_ANALYZED. ` +
        `(2) Call get_task_context({ key: "file-index" }) — load the actual file list. ` +
        `(3) Find the FIRST file where read_status="PENDING". ` +
        `(4) Mark it DONE: update read_status="DONE" inside FILE_INDEX array and call edit_task_context. ` +
        `(5) Move to the next PENDING file. Skip files that keep erroring.`
      );

    case 'duplicate-blocked':
      return (
        `[ORCHESTRATOR INTERVENTION] "${toolName}" was called with identical arguments ` +
        `${config.fingerprintMaxDupes} times. This action already completed. ` +
        `Do NOT repeat it. Move to the NEXT required action ` +
        `(next graph type or next file in FILE_INDEX).`
      );

    case 'bookkeeping-loop':
      return (
        `[ORCHESTRATOR INTERVENTION] You have made ${config.bookkeepingStreakMax} ` +
        `state-only calls in a row (get_task_context / edit_task_context / todoWrite) ` +
        `without any real analysis. You are spinning, not progressing — and wasting LLM calls. ` +
        `Do ONE of these NOW: ` +
        `(1) If a PENDING file remains: read it (getFileContent / batch-read-files) and ` +
        `extract its data via append-to-knowledge-graph. ` +
        `(2) If NO PENDING files remain in this batch: STOP — reply with a one-line summary ` +
        `and DO NOT call any more tools. Do not re-save context that is already saved.`
      );

    case 'config-error':
      return (
        `[ORCHESTRATOR INTERVENTION] A configuration error occurred in "${toolName}". ` +
        `The session context is missing required properties (e.g. modernPath is null). ` +
        `This is not recoverable by retrying the same tool call. ` +
        `Stop tool execution and report the error.`
      );

    case 'tool-not-found':
      return (
        `[ORCHESTRATOR INTERVENTION] Tool "${toolName}" is not registered. ` +
        `Only call tools from the tools list provided at the start of this session. ` +
        `Check the available tool names and use the correct one.`
      );

    default:
      return (
        `[ORCHESTRATOR INTERVENTION] An unexpected error occurred in "${toolName}". ` +
        `Read the tool result error message above and decide the correct recovery action. ` +
        `If you cannot recover, mark the current file DONE and move to the next PENDING file.`
      );
  }
}
