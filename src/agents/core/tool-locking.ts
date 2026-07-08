

import { toolRegistry } from '../../core/tool-invocation-registry.js';
import { ToolContext } from '../../types/tool.js';

// Returns a copy of `tools` where write_file ignores whatever relativePath/
// path/file_path the model supplies and always writes to `lockedRelativePath`
// instead. The model still sees the same tool name/description/schema — this
// is a deterministic server-side correction, not a prompt-level suggestion,
// so it cannot be defeated by the model choosing a different path.
export function lockWriteFileTool(
  tools: ReturnType<typeof toolRegistry.getFunctions>,
  lockedRelativePath: string
): ReturnType<typeof toolRegistry.getFunctions> {
  return tools.map(tool => {
    if (tool.name !== 'write_file') return tool;
    return {
      ...tool,
      handler: async (arg_string: string, ctx?: ToolContext) => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(arg_string || '{}'); } catch { /* fall through with empty args */ }
        const corrected = JSON.stringify({
          ...args,
          relativePath: lockedRelativePath,
          path: undefined,
          file_path: undefined,
        });
        return tool.handler(corrected, ctx);
      },
    };
  });
}
