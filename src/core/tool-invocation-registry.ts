// =============================================================================
//  core/tool-invocation-registry.ts
//  Mirrors: snside packages/ai-core/src/common/tool-invocation-registry.ts
//
//  Singleton registry for all ToolRequest objects.
//  Agents call getFunctions(...toolIds) to get their tools.
//  Tools call registerTool() at startup to contribute themselves.
// =============================================================================

import { ToolRequest } from '../types/tool.js';

// ── Interface (mirrors SNS IDE ToolInvocationRegistry) ───────────────────────

export interface IToolInvocationRegistry {
  registerTool(tool: ToolRequest): void;
  getFunction(toolId: string): ToolRequest | undefined;
  getFunctions(...toolIds: string[]): ToolRequest[];
  getAllFunctions(): ToolRequest[];
  unregisterAllTools(providerName: string): void;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class ToolInvocationRegistryImpl implements IToolInvocationRegistry {
  private tools = new Map<string, ToolRequest>();

  registerTool(tool: ToolRequest): void {
    if (this.tools.has(tool.id)) {
      // Warn but allow re-register (hot-reload friendly)
      console.warn(`[ToolRegistry] Tool with id "${tool.id}" is already registered — skipping.`);
      return;
    }
    this.tools.set(tool.id, tool);
  }

  getFunction(toolId: string): ToolRequest | undefined {
    return this.tools.get(toolId);
  }

  getFunctions(...toolIds: string[]): ToolRequest[] {
    return toolIds
      .map(id => {
        const tool = this.tools.get(id);
        if (!tool) {
          console.warn(`[ToolRegistry] Tool "${id}" not found in registry.`);
        }
        return tool;
      })
      .filter((t): t is ToolRequest => t !== undefined);
  }

  getAllFunctions(): ToolRequest[] {
    return Array.from(this.tools.values());
  }

  unregisterAllTools(providerName: string): void {
    const toRemove: string[] = [];
    for (const [id, tool] of this.tools.entries()) {
      if (tool.providerName === providerName) {
        toRemove.push(id);
      }
    }
    toRemove.forEach(id => this.tools.delete(id));
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────
// All agents and tool files import THIS instance.
export const toolRegistry = new ToolInvocationRegistryImpl();
