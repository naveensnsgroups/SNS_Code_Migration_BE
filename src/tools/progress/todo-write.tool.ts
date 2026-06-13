// =============================================================================
//  tools/progress/todo-write.tool.ts
//  Mirrors: TodoWriteTool (snside todo-tool.ts)
// =============================================================================

import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { TaskContextManager } from '../../session/taskContext.js';
import { EventBroadcaster } from '../../routes/stream.js';
import { TODO_WRITE_FUNCTION_ID } from '../../common/workspace-functions.js';
// TODO_WRITE_FUNCTION_ID = 'todoWrite' — SNS IDE exact value

export const todoWriteTool: ToolRequest = {
  id: TODO_WRITE_FUNCTION_ID,
  name: 'todoWrite',
  providerName: 'migration-progress',
  description:
    'Writes/updates a todo task list for progress tracking. Use this to mark files as analyzed or migrated. ' +
    'Each call broadcasts a todo_update SSE event so the terminal shows live progress.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Array of todo items.',
        items: {
          type: 'object',
          properties: {
            title:    { type: 'string', description: 'Task title, e.g. "Analyzed: src/auth.js".' },
            status:   { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Task status.' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task priority.' }
          },
          required: ['title', 'status']
        }
      }
    },
    required: ['todos']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const args: { todos: Array<{ title: string; status: string; priority?: string }> } = JSON.parse(arg_string || '{}');
    await TaskContextManager.updateContext(ctx!.sessionId, { 'todo-list': args.todos });
    EventBroadcaster.broadcast(ctx!.sessionId, 'todo_update', { todos: args.todos, timestamp: new Date().toISOString() });
    const completed = args.todos.filter(t => t.status === 'completed').length;
    const total = args.todos.length;
    ctx!.onLog?.(`[Todo] ${completed}/${total} tasks completed.`, 'info');
    return makeToolTextResult(JSON.stringify({ saved: true, count: total, completed }));
  }
};
