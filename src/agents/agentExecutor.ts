import { AIService, ChatMessage } from '../ai/provider.js';
import { TOOLS_REGISTRY, ToolDefinition, ToolContext } from '../tools/registry.js';

// ─────────────────────────────────────────────────────────────────────────────
//  AgentExecutor — Sub-Agent Tool Loop
//
//  Runs an LLM in a tool-call loop, feeding tool results back into the
//  conversation until the model produces a final text response (no tool calls).
//
//  This mirrors the snside AbstractModeAwareChatAgent invoke() loop pattern:
//  - Send messages to LLM
//  - If LLM returns tool calls: execute them, append results, loop
//  - If LLM returns text with no tool calls: return that as the final answer
//  - If max iterations reached: return the last text response gracefully
//    (do NOT throw — the agent may have written files and that is valid success)
// ─────────────────────────────────────────────────────────────────────────────

export class AgentExecutor {
  /**
   * Executes a task using an AIService and a set of tools.
   * Runs a tool-call loop until the model produces a final response or max iterations reached.
   *
   * @param aiService      — The LLM provider service
   * @param prompt         — The initial user instruction
   * @param systemPrompt   — The agent's system persona and rules
   * @param enabledTools   — The specific tools available to this agent in this phase
   * @param context        — Session context: sessionId, legacyPath, modernPath, onLog
   * @param maxIterations  — Maximum LLM turns before stopping (default: 40)
   * @returns              — The final text response from the LLM
   */
  static async execute(
    aiService: AIService,
    prompt: string,
    systemPrompt: string,
    enabledTools: ToolDefinition[],
    context: ToolContext,
    maxIterations = 40
  ): Promise<string> {
    const messages: ChatMessage[] = [];

    // Initialize conversation
    messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    let iteration = 0;
    let lastTextResponse = '';

    while (iteration < maxIterations) {
      iteration++;
      context.onLog?.(`[AI Request] Submitting query to LLM (Turn ${iteration})...`, 'info');

      const response = await aiService.generateCompletion(messages, undefined, enabledTools);

      // Capture any text the model outputs on this turn
      if (response.text) {
        lastTextResponse = response.text;
      }

      // ── Final Answer — no tool calls ──────────────────────────────────────
      if (!response.toolCalls || response.toolCalls.length === 0) {
        context.onLog?.(`[AI Response] Received final completion after ${iteration} turn(s).`, 'success');
        return response.text || lastTextResponse;
      }

      // ── Tool Calls — execute and loop back ────────────────────────────────
      // Append the assistant's intent (tool calls) to the conversation history
      messages.push({
        role: 'assistant',
        content: response.text || '',
        toolCalls: response.toolCalls
      });

      // Execute each tool call requested by the LLM
      for (const toolCall of response.toolCalls) {
        const toolName = toolCall.function.name;
        let args: any = {};

        try {
          args = JSON.parse(toolCall.function.arguments || '{}');
        } catch (e) {
          context.onLog?.(
            `[AgentExecutor] Failed to parse arguments for tool "${toolName}": ${toolCall.function.arguments}`,
            'error'
          );
        }

        // Look up the tool in the registry
        const registeredTool = TOOLS_REGISTRY[toolName];

        if (!registeredTool) {
          const errorMsg = `Tool "${toolName}" is not registered. Available tools: ${enabledTools.map(t => t.name).join(', ')}`;
          context.onLog?.(`[AgentExecutor] Warning: ${errorMsg}`, 'warning');
          messages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            name: toolName,
            content: JSON.stringify({ error: errorMsg })
          });
          continue;
        }

        context.onLog?.(`🔧 [Tool Call] Executing tool "${toolName}"...`, 'info');

        try {
          const result = await registeredTool.handler(args, context);
          context.onLog?.(`✅ [Tool Response] Completed "${toolName}" successfully.`, 'success');

          messages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            name: toolName,
            content: JSON.stringify(result)
          });
        } catch (err: any) {
          const errMsg = err.message || 'Unknown tool execution error';
          context.onLog?.(`❌ [Tool Error] Failed executing "${toolName}": ${errMsg}`, 'error');

          messages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            name: toolName,
            content: JSON.stringify({ error: errMsg })
          });
        }
      }
    }

    // ── Max Iterations Reached ────────────────────────────────────────────
    // The agent may have already written output files (Stage1_Analysis.md) via write_file.
    // Do NOT throw — return the last text response the model produced.
    context.onLog?.(
      `[AgentExecutor] Maximum ${maxIterations} iterations reached. Returning last response. The agent may have already written output files.`,
      'warning'
    );
    return lastTextResponse || `Agent completed ${maxIterations} turns. Please check the output workspace for generated files.`;
  }
}
