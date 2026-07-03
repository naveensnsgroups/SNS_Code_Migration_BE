

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
} from './agent-loop-config.js';

export { COST_TABLE, estimateCost } from '../compactor/agent-cost-estimator.js';

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
    agentId = 'migration-agent'
  ): Promise<string> {
    
    
    
    const loopConfig = resolveLoopConfig(modelName);
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

    while (iteration < loopConfig.maxIterations) {
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
      
      const pendingToolCalls = new Map<string, { id: string; name: string; args: string }>();

      
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
              
              pendingToolCalls.set(tc.id, {
                id: tc.id,
                name: tc.function.name,
                args: tc.function.arguments ?? '{}',
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
        
        for (const tc of pendingToolCalls.values()) {
          let parsedInput: unknown = {};
          try { parsedInput = JSON.parse(tc.args); } catch {  }

          messages.push({
            actor: 'ai',
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: parsedInput,
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
                name: tc.name, args: parsedArgs, agentId,
              });

              try {
                
                result = await tool.handler(tc.args, { ...context, toolCallId: tc.id });
                context.onLog?.(`[Tool Response] Completed "${tc.name}" successfully.`, 'success');
                EventBroadcaster.broadcast(context.sessionId, 'tool_response', {
                  name: tc.name, success: true,
                });

                
                loopState.toolCallFingerprints.push(fingerprint);
                if (loopState.toolCallFingerprints.length > loopConfig.fingerprintWindow) {
                  loopState.toolCallFingerprints.shift(); 
                }
                
                
                if (!hasToolError(result)) {
                  loopState.toolCallFingerprints = loopState.toolCallFingerprints
                    .filter(f => !f.startsWith(`${tc.name}::`));
                }
              } catch (err: unknown) {
                const errMsg = err instanceof Error ? err.message : 'Unknown tool execution error';
                context.onLog?.(`[Tool Error] Failed executing "${tc.name}": ${errMsg}`, 'error');
                EventBroadcaster.broadcast(context.sessionId, 'tool_response', {
                  name: tc.name, success: false,
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
          const allResults = messages.filter(m => m.type === 'tool_result') as ToolResultMessage[];
          const lastN      = allResults.slice(-loopConfig.stuckToolWindow);
          if (lastN.length >= loopConfig.stuckToolWindow) {
            const firstName        = lastN[0].name;
            const allSameToolErrors = lastN.every(
              r => r.name === firstName && r.is_error === true
            );
            if (allSameToolErrors) {
              const stuckMsg = buildRecoveryMessage('stuck-tool', firstName, loopConfig);
              messages.push({ actor: 'user', type: 'text', text: stuckMsg } as TextMessage);
              resetStateForErrorType(loopState, 'stuck-tool');
              context.onLog?.(
                `[AgentExecutor] STUCK DETECTED: "${firstName}" failed ` +
                `${loopConfig.stuckToolMaxErrors}x in a row — injected recovery.`,
                'warning'
              );
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

        
        continue;
      }

      
      context.onLog?.(`[AI Response] Final completion after ${iteration} turn(s).`, 'success');
      return turnText || lastTextResponse;
    }

    
    context.onLog?.(
      `[AgentExecutor] Max ${loopConfig.maxIterations} iterations reached. Agent may have written output files.`,
      'warning'
    );
    return lastTextResponse || `Agent completed ${loopConfig.maxIterations} turns. Check output workspace for generated files.`;
  }
}
