// =============================================================================
//  workspace-functions.ts — All Tool ID Constants
//
//  Mirrors EXACTLY:
//    snside/packages/ai-ide/src/common/workspace-functions.ts
//    snside/packages/ai-ide/src/common/todo-tool.ts
//    snside/packages/ai-ide/src/common/task-context-function-ids.ts
//
//  NEVER use inline string literals for tool IDs. Always import from here.
//  This ensures prompts copied from the SNS IDE work with zero changes.
// =============================================================================

// ── Core Workspace Tools ──────────────────────────────────────────────────────
export const FILE_CONTENT_FUNCTION_ID                      = 'getFileContent';
export const GET_WORKSPACE_FILE_LIST_FUNCTION_ID           = 'getWorkspaceFileList';
export const GET_WORKSPACE_DIRECTORY_STRUCTURE_FUNCTION_ID = 'getWorkspaceDirectoryStructure';
export const GET_FILE_DIAGNOSTICS_ID                       = 'getFileDiagnostics';
export const SEARCH_IN_WORKSPACE_FUNCTION_ID               = 'searchInWorkspace';
export const FIND_FILES_BY_PATTERN_FUNCTION_ID             = 'findFilesByPattern';

// ── Task / Launch Tools ───────────────────────────────────────────────────────
export const LIST_TASKS_FUNCTION_ID                        = 'listTasks';
export const RUN_TASK_FUNCTION_ID                          = 'runTask';
export const LIST_LAUNCH_CONFIGURATIONS_FUNCTION_ID        = 'listLaunchConfigurations';
export const RUN_LAUNCH_CONFIGURATION_FUNCTION_ID          = 'runLaunchConfiguration';
export const STOP_LAUNCH_CONFIGURATION_FUNCTION_ID         = 'stopLaunchConfiguration';

// ── Skill Tools ───────────────────────────────────────────────────────────────
export const GET_SKILL_FILE_CONTENT_FUNCTION_ID            = 'getSkillFileContent';

// ── Shell Execution Tools ─────────────────────────────────────────────────────
export const SHELL_EXECUTION_FUNCTION_ID                   = 'shellExecute';
/** Captures stdout + stderr from a shell command. Returns exit_code, tails, timed_out flag. */
export const CAPTURED_SHELL_EXECUTION_ID                   = 'capturedShellExecute';
/** Run arbitrary terminal commands (build, test, lint). */
export const RUN_COMMAND_FUNCTION_ID                       = 'run_command';

// ── File Write / Edit Tools ───────────────────────────────────────────────────
/** Write a single file to the modern workspace. */
export const WRITE_FILE_FUNCTION_ID                        = 'write_file';

// ── Todo / Progress Tracking (mirrors todo-tool.ts) ──────────────────────────
/** Per-file todo audit trail — broadcasts live progress to terminal SSE. */
export const TODO_WRITE_FUNCTION_ID                        = 'todoWrite';

// ── Task Context Tools (mirrors task-context-function-ids.ts) ────────────────
/** Reads the current agent task context / scratchpad. */
export const GET_TASK_CONTEXT_FUNCTION_ID                  = 'get_task_context';
/** Updates the current agent task context / scratchpad. */
export const EDIT_TASK_CONTEXT_FUNCTION_ID                 = 'edit_task_context';

// ── Migration Planner — Phase 3 Analysis Tools ───────────────────────────────
export const GET_DEPENDENCY_TREE_FUNCTION_ID               = 'getDependencyTree';
export const GET_GIT_LOG_FUNCTION_ID                       = 'getGitLog';
export const COMPARE_FILES_FUNCTION_ID                     = 'compareFiles';
export const GET_ENVIRONMENT_INFO_FUNCTION_ID              = 'getEnvironmentInfo';

// ── Migration Planner — Phase 4 Advanced Tools ───────────────────────────────
/** Large-file symbol navigator (Claude Code / Cursor strategy). */
export const EXTRACT_FILE_SYMBOLS_FUNCTION_ID              = 'extractFileSymbols';
/** Scans all non-code assets: images, fonts, CSS, env files, SQL, Docker. */
export const SCAN_ASSET_FILES_FUNCTION_ID                  = 'scanAssetFiles';
export const COPY_STATIC_ASSETS_FUNCTION_ID                = 'copyStaticAssets';

// ── Migration Planner — Production-Grade Orchestration Tools ─────────────────
/** Batch-read multiple files in one call (context-efficient). */
export const BATCH_READ_FILES_FUNCTION_ID                  = 'batch-read-files';
/** Archives completed phase data to protect context window space. */
export const COMPRESS_MIGRATION_CONTEXT_FUNCTION_ID        = 'compress-migration-context';
/** Broadcasts live progress bar + phase updates to the frontend dashboard. */
export const UPDATE_MIGRATION_DASHBOARD_FUNCTION_ID        = 'update-migration-dashboard';
/** Batch-write multiple modern files in one call. */
export const WRITE_MIGRATION_FILES_FUNCTION_ID             = 'write-migration-files';
/** Find and recover an existing migration session by project path. */
export const FIND_MIGRATION_SESSION_FUNCTION_ID            = 'find-migration-session';

// ── Knowledge Graph Tools (Stage 1 cross-file synthesis) ─────────────────────
/** Merges analysis data into a named knowledge graph file (_analysis/<name>-graph.json). */
export const APPEND_TO_KNOWLEDGE_GRAPH_FUNCTION_ID         = 'append-to-knowledge-graph';
/** Reads a fully-merged knowledge graph file for report writing. */
export const READ_KNOWLEDGE_GRAPH_FUNCTION_ID              = 'read-knowledge-graph';
