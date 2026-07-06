// Type-only module.
//
// This file previously also held a ~1600-line `TOOLS_REGISTRY` object — a second,
// drifted implementation of nearly every tool that was never imported anywhere
// (the live tools are the modular `*.tool.ts` files registered via
// `tools/index.ts` into `tool-invocation-registry.ts`). It has been removed to
// prevent future edits landing in dead code. Only these provider-facing types
// remain, still imported by the ai/* language-model adapters.

export interface ToolContext {
  sessionId: string;
  legacyPath: string;
  modernPath: string;
  onLog?: (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (args: any, context: ToolContext) => Promise<any>;
}
