// =============================================================================
//  tools/index.ts
//  Central registration point — imports every ToolRequest and registers it
//  into the toolRegistry singleton (core/tool-invocation-registry.ts).
//
//  SNS IDE pattern: Each tool is its own file (ToolProvider pattern).
//  This index mirrors the @postConstruct init() in ToolInvocationRegistryImpl.
//
//  Import this ONCE at application startup (e.g. in src/index.ts).
//  After this runs: toolRegistry.getFunctions(...ids) works for all agents.
// =============================================================================

import { toolRegistry } from '../core/tool-invocation-registry.js';

// ── Workspace (read-only) ─────────────────────────────────────────────────────
import { getDirectoryStructureTool } from './workspace/get-directory-structure.tool.js';
import { getFileListTool }           from './workspace/get-file-list.tool.js';
import { getFileContentTool }        from './workspace/get-file-content.tool.js';
import { searchInWorkspaceTool }     from './workspace/search-in-workspace.tool.js';
import { findFilesByPatternTool }    from './workspace/find-files-by-pattern.tool.js';
import { getDependencyTreeTool }     from './workspace/get-dependency-tree.tool.js';
import { getFileDiagnosticsTool }    from './workspace/get-file-diagnostics.tool.js';
import { batchReadFilesTool }        from './workspace/batch-read-files.tool.js';
import { extractFileSymbolsTool }    from './workspace/extract-file-symbols.tool.js';
import { scanAssetFilesTool }        from './workspace/scan-asset-files.tool.js';

// ── Environment / System ──────────────────────────────────────────────────────
import { getEnvironmentInfoTool }    from './environment/get-environment-info.tool.js';
import { getGitLogTool }             from './environment/get-git-log.tool.js';
import { capturedShellExecuteTool }  from './environment/captured-shell-execute.tool.js';

// ── Output (write) ────────────────────────────────────────────────────────────
import { writeFileTool }             from './output/write-file.tool.js';
import { writeMigrationFilesTool }   from './output/write-migration-files.tool.js';
import { copyStaticAssetsTool }      from './output/copy-static-assets.tool.js';

// ── Memory (persistent context) ───────────────────────────────────────────────
import { getTaskContextTool }        from './memory/get-task-context.tool.js';
import { editTaskContextTool }       from './memory/edit-task-context.tool.js';

// ── Progress (SSE broadcast) ──────────────────────────────────────────────────
import { todoWriteTool }                     from './progress/todo-write.tool.js';
import { updateMigrationDashboardTool }      from './progress/update-migration-dashboard.tool.js';
import { compressMigrationContextTool }      from './progress/compress-migration-context.tool.js';

// ── Session ───────────────────────────────────────────────────────────────────
import { findMigrationSessionTool }  from './session/find-migration-session.tool.js';
import { getSkillFileContentTool }   from './session/get-skill-file-content.tool.js';

// ── Compare ───────────────────────────────────────────────────────────────────
import { compareFilesTool }          from './compare/compare-files.tool.js';

// ── Register all tools ────────────────────────────────────────────────────────
// Order does not matter — each tool has a unique ID.

export function registerAllTools(): void {
  // Workspace
  toolRegistry.registerTool(getDirectoryStructureTool);
  toolRegistry.registerTool(getFileListTool);
  toolRegistry.registerTool(getFileContentTool);
  toolRegistry.registerTool(searchInWorkspaceTool);
  toolRegistry.registerTool(findFilesByPatternTool);
  toolRegistry.registerTool(getDependencyTreeTool);
  toolRegistry.registerTool(getFileDiagnosticsTool);
  toolRegistry.registerTool(batchReadFilesTool);
  toolRegistry.registerTool(extractFileSymbolsTool);
  toolRegistry.registerTool(scanAssetFilesTool);

  // Environment
  toolRegistry.registerTool(getEnvironmentInfoTool);
  toolRegistry.registerTool(getGitLogTool);
  toolRegistry.registerTool(capturedShellExecuteTool);

  // Output
  toolRegistry.registerTool(writeFileTool);
  toolRegistry.registerTool(writeMigrationFilesTool);
  toolRegistry.registerTool(copyStaticAssetsTool);

  // Memory
  toolRegistry.registerTool(getTaskContextTool);
  toolRegistry.registerTool(editTaskContextTool);

  // Progress
  toolRegistry.registerTool(todoWriteTool);
  toolRegistry.registerTool(updateMigrationDashboardTool);
  toolRegistry.registerTool(compressMigrationContextTool);

  // Session
  toolRegistry.registerTool(findMigrationSessionTool);
  toolRegistry.registerTool(getSkillFileContentTool);

  // Compare
  toolRegistry.registerTool(compareFilesTool);
}

// ── Tool ID Constants: Single Source of Truth ─────────────────────────────────
// ALL tool ID constants are defined in ONE place:
//   src/common/workspace-functions.ts  (mirrors SNS IDE exactly)
//
// To use tool IDs, always import from workspace-functions:
//   import { FILE_CONTENT_FUNCTION_ID, WRITE_FILE_FUNCTION_ID, ... }
//     from '../common/workspace-functions.js';
//
// Individual tool files no longer export their own constants.
// They import from workspace-functions.ts themselves (SNS IDE standard).
