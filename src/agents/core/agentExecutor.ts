

import {
  LanguageModelMessage,
  TextMessage,
  ToolUseMessage,
  ToolResultMessage,
  LanguageModelStreamPart,
  makeToolErrorResult,
  makeToolTextResult,
  isTextResponsePart,
  isUsageResponsePart,
  isToolCallResponsePart,
  ToolCallResult,
  UserRequest,
  StreamingProvider,
  hasToolError,
} from '../../types/language-model.js';
import { ToolRequest, ToolContext } from '../../types/tool.js';
import { EventBroadcaster } from '../../routes/stream.js';
import { SessionManager } from '../../session/sessionManager.js';
import { TokenUsage } from '../../types.js';
import { TokenUsageEntry } from '../../session/types.js';

import {
  resolveCompactionCharBudget,
  compactMessagesIfNeeded,
} from '../compactor/agent-context-compactor.js';

import {
  resolveLoopConfig,
  classifyToolError,
  buildRecoveryMessage,
  resetStateForErrorType,
  createLoopState,
  LoopState,
  BOOKKEEPING_TOOL_NAMES,
} from './agent-loop-config.js';
import { isToolCallContentWrapper } from '../../types/language-model.js';

export { estimateCost } from '../compactor/agent-cost-estimator.js';
export type { ModelPricingRate, ModelPricingConfig } from '../compactor/agent-cost-estimator.js';

function sortKeysDeep(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortKeysDeep);
  if (val !== null && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => { acc[k] = sortKeysDeep(obj[k]); return acc; }, {});
  }
  return val;
}

function normalizeToolArgs(rawArgs: string): string {
  try {
    return JSON.stringify(sortKeysDeep(JSON.parse(rawArgs)));
  } catch {
    return rawArgs;
  }
}

// Extract the human-readable text a tool result carries (what the LLM received),
// for the observability channel. Handles the structured content-wrapper, plain
// strings, and arbitrary objects.
function extractResultText(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  if (isToolCallContentWrapper(result as any)) {
    return (result as any).content
      .map((c: any) => c.text ?? c.data ?? '')
      .filter(Boolean)
      .join('\n');
  }
  try { return JSON.stringify(result); } catch { return String(result); }
}

// Show the real result up to a generous cap (default ~12KB) so the UI can display
// full file reads / graph reads / edit payloads — not a tiny 300-char snippet.
// Anything larger is truncated with an honest marker.
function truncateForLog(text: string, cap = 12_000): string {
  if (!text) return '';
  if (text.length <= cap) return text;
  return (
    text.slice(0, cap) +
    `\n… [truncated — showing ${(cap / 1000).toFixed(0)}KB of ${(text.length / 1000).toFixed(1)}KB; the agent used the full result]`
  );
}

const RATE_LIMIT_PATTERNS = [
  'rate limit', 'rate_limit', 'ratelimit',
  'quota exceeded', 'too many requests',
  'resource exhausted', 'resourceexhausted',
  '429', '503',
];

function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return RATE_LIMIT_PATTERNS.some(p => msg.includes(p));
}

async function requestWithRetry(
  provider:    { request: (...args: any[]) => any },
  userRequest: any,
  context:     any,
  maxRetries = 4
): Promise<any> {
  let delay = 2000; 
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await provider.request(userRequest, context);
    } catch (err: unknown) {
      if (isRateLimitError(err) && attempt < maxRetries) {
        context.onLog?.(
          `[AgentExecutor] Rate limit hit — waiting ${delay / 1000}s before retry ${attempt + 1}/${maxRetries}...`,
          'warning'
        );
        await new Promise(res => setTimeout(res, delay));
        delay = Math.min(delay * 2, 32000); 
        continue;
      }
      throw err; 
    }
  }
  throw new Error(`Rate limit persisted after ${maxRetries} retries. Check your API quota.`);
}

export class AgentExecutor {
  
  static async execute(
    provider: StreamingProvider,
    systemPrompt: string,
    userPrompt: string,
    tools: ToolRequest[],
    context: ToolContext,
    modelName = '',
    agentId = 'migration-agent',
    // Optional per-run cap on turns. The analysis phase passes a small value so a
    // single pass cannot run 30+ turns and blow a rate-limited token/minute budget.
    maxIterationsOverride?: number
  ): Promise<string> {



    const loopConfig = resolveLoopConfig(modelName);
    const effectiveMaxIterations = Math.min(
      loopConfig.maxIterations,
      maxIterationsOverride && maxIterationsOverride > 0 ? maxIterationsOverride : loopConfig.maxIterations
    );
    const loopState: LoopState = createLoopState();

    
    const messages: LanguageModelMessage[] = [
      { actor: 'system', type: 'text', text: systemPrompt } as TextMessage,
      { actor: 'user',   type: 'text', text: userPrompt   } as TextMessage,
    ];

    let iteration = 0;
    let lastTextResponse = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    
    const compactionCharBudget = resolveCompactionCharBudget(modelName);

    while (iteration < effectiveMaxIterations) {
      iteration++;

      
      compactMessagesIfNeeded(messages, compactionCharBudget, iteration, context.onLog);

      context.onLog?.(`[AI Request] Submitting query to LLM (Turn ${iteration})...`, 'info');

      const userRequest: UserRequest = {
        messages: [...messages],
        tools,
        sessionId: context.sessionId,
        requestId: `req_${context.sessionId}_t${iteration}`,
        modelName,
      };

      
      let turnText = '';
      
      const pendingToolCalls = new Map<string, { id: string; name: string; args: string; providerMetadata?: Record<string, unknown> }>();

      
      const response = await requestWithRetry(provider, userRequest, context);

      for await (const part of response.stream) {
        if (isTextResponsePart(part)) {
          turnText += part.content;
          
          EventBroadcaster.broadcast(context.sessionId, 'log', {
            message: part.content,
            level: 'stream',  
            phase: 'agent'
          });
        } else if (isUsageResponsePart(part)) {
          const partInput = part.input_tokens;
          const partOutput = part.output_tokens;
          const partCacheCreation = part.cache_creation_input_tokens ?? 0;
          const partCacheRead = part.cache_read_input_tokens ?? 0;

          if (partInput > 0 || partOutput > 0 || partCacheCreation > 0 || partCacheRead > 0) {
            await SessionManager.recordTokenUsage(
              context.sessionId,
              partInput,
              partOutput,
              modelName,
              agentId,
              partCacheCreation > 0 ? partCacheCreation : undefined,
              partCacheRead > 0 ? partCacheRead : undefined
            );
          }
        } else if (isToolCallResponsePart(part)) {
          for (const tc of part.tool_calls) {
            if (tc.id && tc.function?.name && !tc.finished) {
              // Merge so a later consolidated part (full args) does not wipe the
              // providerMetadata captured on an earlier part for the same call.
              const prev = pendingToolCalls.get(tc.id);
              pendingToolCalls.set(tc.id, {
                id: tc.id,
                name: tc.function.name,
                args: tc.function.arguments ?? '{}',
                providerMetadata: tc.providerMetadata ?? prev?.providerMetadata,
              });
            } else if (tc.id && tc.finished) {
              
              
              
              
              
              const existing = pendingToolCalls.get(tc.id);
              if (existing) {
                
                if (tc.result !== undefined) {
                  messages.push({
                    actor: 'user',
                    type: 'tool_result',
                    tool_use_id: tc.id,
                    name: existing.name,
                    content: tc.result as ToolCallResult,
                    is_error: hasToolError(tc.result as ToolCallResult),
                  } as ToolResultMessage);
                }
                
                EventBroadcaster.broadcast(context.sessionId, 'tool_response', {
                  id: tc.id,
                  toolName:  existing.name,
                  success:   !hasToolError(tc.result as ToolCallResult),
                  inStream:  true,
                });
                context.onLog?.(`[Tool Response] ${existing.name} completed (in-stream, result recorded).`, 'success');
                pendingToolCalls.delete(tc.id);
              }
            }
          }
        }
      }

      if (turnText) lastTextResponse = turnText;

      
      
      
      
      if (
        turnText.length > loopConfig.reasoningLoopThreshold &&
        pendingToolCalls.size === 0 &&
        iteration > 1
      ) {
        const snippet  = turnText.slice(0, loopConfig.reasoningLoopSnippet);
        const dropped  = Math.round((turnText.length - loopConfig.reasoningLoopSnippet) / 1_000);
        const truncated = snippet +
          `\n[...${dropped}K chars of repeated planning text omitted by orchestrator...]`;

        
        messages.push({ actor: 'ai', type: 'text', text: truncated } as TextMessage);

        
        const recoveryMsg = buildRecoveryMessage(
          'reasoning-loop', '', loopConfig, { turnChars: turnText.length }
        );
        messages.push({ actor: 'user', type: 'text', text: recoveryMsg } as TextMessage);

        resetStateForErrorType(loopState, 'reasoning-loop');
        context.onLog?.(
          `[AgentExecutor] REASONING LOOP (${loopConfig.reasoningLoopThreshold / 1_000}K threshold): ` +
          `Turn ${iteration} generated ${Math.round(turnText.length / 1_000)}K chars, zero tool calls — injected recovery.`,
          'warning'
        );
        continue;
      }

      
      
      if (pendingToolCalls.size > 0) {
        // Preserve the assistant's reasoning text from this turn as history before
        // its tool_use calls. Providers now stream one turn and do NOT build the
        // assistant message themselves (the executor owns the loop), so the text
        // would otherwise be dropped. Provider message transforms merge this text
        // with the following tool_use blocks into one assistant message.
        if (turnText.trim()) {
          messages.push({ actor: 'ai', type: 'text', text: turnText } as TextMessage);
        }

        for (const tc of pendingToolCalls.values()) {
          let parsedInput: unknown = {};
          try { parsedInput = JSON.parse(tc.args); } catch {  }

          messages.push({
            actor: 'ai',
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: parsedInput,
            providerMetadata: tc.providerMetadata,
          } as ToolUseMessage);
        }

        
        for (const tc of pendingToolCalls.values()) {
          const tool = tools.find(t => t.name === tc.name);
          let result: ToolCallResult;

          if (!tool) {
            const errMsg = `Tool '${tc.name}' not registered. Available: ${tools.map(t => t.name).join(', ')}`;
            context.onLog?.(`[AgentExecutor] ${errMsg}`, 'warning');
            result = makeToolErrorResult(
              buildRecoveryMessage('tool-not-found', tc.name, loopConfig),
              'tool-not-found'
            );
          } else {
            
            
            
            
            const fingerprint  = `${tc.name}::${normalizeToolArgs(tc.args)}`;
            const dupeCount    = loopState.toolCallFingerprints.filter(f => f === fingerprint).length;

            if (dupeCount >= loopConfig.fingerprintMaxDupes) {
              
              const dupeMsg = buildRecoveryMessage('duplicate-blocked', tc.name, loopConfig);
              context.onLog?.(
                `[AgentExecutor] DUPLICATE BLOCKED: "${tc.name}" with same args already called ` +
                `${dupeCount}x (limit: ${loopConfig.fingerprintMaxDupes}).`,
                'warning'
              );
              result = makeToolErrorResult(dupeMsg, 'duplicate-blocked');
              
            } else {
              context.onLog?.(`[Tool Call] Executing tool "${tc.name}"...`, 'info');

              
              let parsedArgs: Record<string, unknown> = {};
              try { parsedArgs = JSON.parse(tc.args) as Record<string, unknown>; } catch {  }
              EventBroadcaster.broadcast(context.sessionId, 'tool_call', {
                id: tc.id, name: tc.name, args: parsedArgs, agentId,
              });

              try {

                result = await tool.handler(tc.args, { ...context, toolCallId: tc.id });
                const isErr = hasToolError(result);
                // Emit the ACTUAL result to the observability channel so the UI can
                // show what the tool returned (not just "completed"). This was lost
                // when tool execution moved out of the providers — restore it here.
                const resultText = extractResultText(result);
                if (resultText) {
                  context.onLog?.(`[Tool Data] ${truncateForLog(resultText)}`, 'info');
                }
                context.onLog?.(`[Tool Response] Completed "${tc.name}" ${isErr ? 'with error' : 'successfully'}.`, isErr ? 'warning' : 'success');
                EventBroadcaster.broadcast(context.sessionId, 'tool_response', {
                  id: tc.id,
                  name: tc.name,
                  success: !isErr,
                  args: parsedArgs,
                  resultPreview: truncateForLog(resultText, 1200),
                });


                loopState.toolCallFingerprints.push(fingerprint);
                if (loopState.toolCallFingerprints.length > loopConfig.fingerprintWindow) {
                  loopState.toolCallFingerprints.shift();
                }


                if (!isErr) {
                  loopState.toolCallFingerprints = loopState.toolCallFingerprints
                    .filter(f => !f.startsWith(`${tc.name}::`));
                  // Productive-progress tracking: bookkeeping tools accumulate the
                  // streak; any productive tool (read/graph/write) resets it.
                  if (BOOKKEEPING_TOOL_NAMES.has(tc.name)) {
                    loopState.bookkeepingStreak++;
                  } else {
                    loopState.bookkeepingStreak = 0;
                  }
                }
              } catch (err: unknown) {
                const errMsg = err instanceof Error ? err.message : 'Unknown tool execution error';
                context.onLog?.(`[Tool Error] Failed executing "${tc.name}": ${errMsg}`, 'error');
                EventBroadcaster.broadcast(context.sessionId, 'tool_response', {
                  id: tc.id, name: tc.name, success: false,
                });
                result = makeToolErrorResult(errMsg);

                
                loopState.toolCallFingerprints.push(fingerprint);
                if (loopState.toolCallFingerprints.length > loopConfig.fingerprintWindow) {
                  loopState.toolCallFingerprints.shift();
                }
              }
            }
          }

          
          messages.push({
            actor: 'user',
            type: 'tool_result',
            tool_use_id: tc.id,
            name: tc.name,
            content: result,
            is_error: hasToolError(result),
          } as ToolResultMessage);
        }

        
        
        
        {
          // Stuck-tool detection: within the last `stuckToolWindow` tool results,
          // a single tool accumulating >= `stuckToolMaxErrors` errors with zero
          // successes triggers a recovery injection. Both config knobs are live:
          // window = how far back to look, maxErrors = per-model trigger threshold.
          const allResults = messages.filter(m => m.type === 'tool_result') as ToolResultMessage[];
          const lastN      = allResults.slice(-loopConfig.stuckToolWindow);
          if (lastN.length > 0) {
            const errorCounts   = new Map<string, number>();
            const successNames  = new Set<string>();
            for (const r of lastN) {
              if (r.is_error === true) {
                errorCounts.set(r.name, (errorCounts.get(r.name) ?? 0) + 1);
              } else {
                successNames.add(r.name);
              }
            }
            for (const [name, errCount] of errorCounts) {
              if (errCount >= loopConfig.stuckToolMaxErrors && !successNames.has(name)) {
                const stuckMsg = buildRecoveryMessage('stuck-tool', name, loopConfig);
                messages.push({ actor: 'user', type: 'text', text: stuckMsg } as TextMessage);
                resetStateForErrorType(loopState, 'stuck-tool');
                context.onLog?.(
                  `[AgentExecutor] STUCK DETECTED: "${name}" failed ` +
                  `${errCount}x within the last ${lastN.length} tool results — injected recovery.`,
                  'warning'
                );
                break;
              }
            }
          }
        }

        
        
        
        {
          const thisTurnIds    = [...pendingToolCalls.keys()];
          const allResults     = messages.filter(m => m.type === 'tool_result') as ToolResultMessage[];
          const thisTurnErrors = thisTurnIds
            .map(id => {
              
              const matches = allResults.filter(r => r.tool_use_id === id);
              return matches.length > 0 ? matches[matches.length - 1] : undefined;
            })
            .filter((r): r is ToolResultMessage => r !== undefined)
            .filter(r => r.is_error === true).length;

          if (thisTurnIds.length > 0 && thisTurnErrors === thisTurnIds.length) {
            
            loopState.noProgressTurns++;
            if (loopState.noProgressTurns >= loopConfig.noProgressMaxTurns) {
              const noProgressMsg = buildRecoveryMessage('no-progress', '', loopConfig);
              messages.push({ actor: 'user', type: 'text', text: noProgressMsg } as TextMessage);
              resetStateForErrorType(loopState, 'no-progress');
              context.onLog?.(
                `[AgentExecutor] NO_PROGRESS: ${loopConfig.noProgressMaxTurns} consecutive all-error turns — injected emergency recovery.`,
                'warning'
              );
            }
          } else if (thisTurnErrors < thisTurnIds.length) {

            loopState.noProgressTurns = 0;
          }
        }

        // Bookkeeping-loop detection: the agent is making SUCCESSFUL state-only
        // calls (edit_task_context / get_task_context / todoWrite) without any
        // productive analysis in between. Invisible to the error/duplicate
        // detectors, so guard it explicitly: nudge to do real work or stop.
        if (loopState.bookkeepingStreak >= loopConfig.bookkeepingStreakMax) {
          const bkMsg = buildRecoveryMessage('bookkeeping-loop', '', loopConfig);
          messages.push({ actor: 'user', type: 'text', text: bkMsg } as TextMessage);
          context.onLog?.(
            `[AgentExecutor] BOOKKEEPING LOOP: ${loopState.bookkeepingStreak} state-only calls ` +
            `with no analysis — injected recovery nudge.`,
            'warning'
          );
          resetStateForErrorType(loopState, 'bookkeeping-loop');
        }


        continue;
      }

      
      context.onLog?.(`[AI Response] Final completion after ${iteration} turn(s).`, 'success');
      return turnText || lastTextResponse;
    }

    
    context.onLog?.(
      `[AgentExecutor] Max ${effectiveMaxIterations} iterations reached. Agent may have written output files.`,
      'warning'
    );
    return lastTextResponse || `Agent completed ${effectiveMaxIterations} turns. Check output workspace for generated files.`;
  }
}
