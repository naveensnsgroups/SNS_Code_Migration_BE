

import { toolRegistry } from '../core/tool-invocation-registry.js';

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

import { getEnvironmentInfoTool }    from './environment/get-environment-info.tool.js';
import { getGitLogTool }             from './environment/get-git-log.tool.js';
import { capturedShellExecuteTool }  from './environment/captured-shell-execute.tool.js';

import { writeFileTool }             from './output/write-file.tool.js';
import { copyStaticAssetsTool }      from './output/copy-static-assets.tool.js';

import { getTaskContextTool }        from './memory/get-task-context.tool.js';
import { editTaskContextTool }       from './memory/edit-task-context.tool.js';

import { todoWriteTool }                     from './progress/todo-write.tool.js';
import { updateMigrationDashboardTool }      from './progress/update-migration-dashboard.tool.js';
import { compressMigrationContextTool }      from './progress/compress-migration-context.tool.js';

import { findMigrationSessionTool }  from './session/find-migration-session.tool.js';

import { appendToKnowledgeGraphTool } from './knowledge/append-to-knowledge-graph.tool.js';
import { readKnowledgeGraphTool }     from './knowledge/read-knowledge-graph.tool.js';

export function registerAllTools(): void {
  
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

  
  toolRegistry.registerTool(getEnvironmentInfoTool);
  toolRegistry.registerTool(getGitLogTool);
  toolRegistry.registerTool(capturedShellExecuteTool);


  toolRegistry.registerTool(writeFileTool);
  toolRegistry.registerTool(copyStaticAssetsTool);

  
  toolRegistry.registerTool(getTaskContextTool);
  toolRegistry.registerTool(editTaskContextTool);

  
  toolRegistry.registerTool(todoWriteTool);
  toolRegistry.registerTool(updateMigrationDashboardTool);
  toolRegistry.registerTool(compressMigrationContextTool);


  toolRegistry.registerTool(findMigrationSessionTool);


  toolRegistry.registerTool(appendToKnowledgeGraphTool);
  toolRegistry.registerTool(readKnowledgeGraphTool);
}

