import { AIService } from '../ai/provider.js';
import { DetectedStack, TargetStack } from '../types.js';
import { TOOLS_REGISTRY, ToolContext } from '../tools/registry.js';
import { AgentExecutor } from './agentExecutor.js';
import { TaskContextManager } from '../session/taskContext.js';
import { ANALYZER_SYSTEM_PROMPT } from '../prompts/analyzer-prompt.js';
import { PLANNER_SYSTEM_PROMPT } from '../prompts/planner-prompt.js';
import fs from 'fs-extra';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
//  PlannerAgent — Stage 1: Codebase Analysis and Migration Planning
//
//  Stage 1 runs two phases in sequence:
//
//  Phase 1 (FileAnalyzer sub-agent):
//    Goal: Fully understand the legacy codebase — language, framework, structure,
//    files, functions, business rules, dependencies, API contracts, DB ops.
//    Output: Stage1_Analysis.md written to modernPath.
//    Tools: Read-only workspace tools + write_file + task context memory.
//    NO target stack context is passed. NO modern framework is mentioned.
//    This is pure legacy codebase discovery and documentation.
//
//  Phase 2 (Planner sub-agent):
//    Goal: Based on Phase 1 analysis, formulate the migration strategy and plan.
//    Reads Stage1_Analysis.md and task context, then writes migration-plan.md.
//    Tools: read only + write_file + task context.
// ─────────────────────────────────────────────────────────────────────────────

export class PlannerAgent {
  /**
   * Runs Stage 1: codebase analysis (Phase 1) and migration plan (Phase 2).
   *
   * @param sessionId     — Active session ID
   * @param legacyPath    — Path to the uploaded legacy source code (read-only)
   * @param modernPath    — Path to the output workspace (Stage1_Analysis.md goes here)
   * @param detectedStack — Heuristic-detected stack info from the initial scan
   * @param targetStack   — Target modernization stack configuration
   * @param aiService     — The LLM provider service
   * @param onLog         — Streaming log callback for terminal output
   */
  static async run(
    sessionId: string,
    legacyPath: string,
    modernPath: string,
    detectedStack: DetectedStack,
    targetStack: TargetStack,
    aiService: AIService,
    onLog?: (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void
  ): Promise<string> {
    onLog?.('Initializing autonomous Stage 1 Agent Pipeline...', 'info');

    const context: ToolContext = {
      sessionId,
      legacyPath,
      modernPath,
      onLog: (msg, lvl) => onLog?.(msg, lvl)
    };

    // Load active phase from task context memory (supports resume after restart)
    let taskContext = await TaskContextManager.getContext(sessionId);
    let activePhase = taskContext.active_phase || '1';

    let resultSummary = '';

    // ────────────────────────────────────────────────────────────────────────
    //  PHASE 1 — Codebase Discovery and Analysis (FileAnalyzer sub-agent)
    //
    //  Tools available (aligned with snside file-analyzer-prompt-template.ts):
    //
    //  WORKSPACE EXPLORATION (read-only — legacy source):
    //    getWorkspaceDirectoryStructure  — full directory tree
    //    getWorkspaceFileList            — list files in a directory
    //    getFileContent                  — read file with optional offset/limit
    //    searchInWorkspace               — full-text search across all files
    //    findFilesByPattern              — glob pattern file finder
    //    getDependencyTree               — parse all manifest files (npm, pip, maven, etc.)
    //    getFileDiagnostics              — placeholder (no LSP in BE mode)
    //    batch-read-files                — read multiple files in one call
    //
    //  PERSISTENT MEMORY (task context — survives restart):
    //    get_task_context                — read all saved state
    //    edit_task_context               — save state, file-index, rules-by-file
    //
    //  OUTPUT WRITING:
    //    write_file                      — writes to modernPath (Stage1_Analysis.md)
    //
    //  NOT included in Phase 1:
    //    run_command — no shell commands during analysis
    //    list_directory / read_file / search_code — legacy names, use new names above
    // ────────────────────────────────────────────────────────────────────────
    if (activePhase === '1') {
      onLog?.('🔎 Phase 1: Starting Codebase Discovery & Analysis...', 'info');

      // Build the initial user prompt for the FileAnalyzer sub-agent.
      // IMPORTANT: NO target stack context here. No mention of "migrate to X".
      // The agent must discover and document the legacy codebase purely.
      const analyzerPrompt = buildAnalyzerPrompt(legacyPath, detectedStack);

      // Tools available to Phase 1 FileAnalyzer — mirrors snside file-analyzer agent tools
      const phase1Tools = [
        // Workspace exploration (read-only)
        TOOLS_REGISTRY.getWorkspaceDirectoryStructure,
        TOOLS_REGISTRY.getWorkspaceFileList,
        TOOLS_REGISTRY.getFileContent,
        TOOLS_REGISTRY.searchInWorkspace,
        TOOLS_REGISTRY.findFilesByPattern,
        TOOLS_REGISTRY.getDependencyTree,
        TOOLS_REGISTRY.getFileDiagnostics,
        TOOLS_REGISTRY['batch-read-files'],
        // Persistent memory
        TOOLS_REGISTRY.get_task_context,
        TOOLS_REGISTRY.edit_task_context,
        // Output
        TOOLS_REGISTRY.write_file,
      ];

      resultSummary = await AgentExecutor.execute(
        aiService,
        analyzerPrompt,
        ANALYZER_SYSTEM_PROMPT,
        phase1Tools,
        context,
        60   // Allow up to 60 turns for thorough analysis of large codebases
      );

      // ── Fallback: If Stage1_Analysis.md was not written by the agent ────
      // The agent should have called write_file itself, but if not (e.g. small
      // codebase where it returned text directly), write the response as fallback.
      const analysisFilePath = path.join(modernPath, 'Stage1_Analysis.md');
      if (!(await fs.pathExists(analysisFilePath))) {
        onLog?.('⚠️ Stage1_Analysis.md was not written by the agent. Writing fallback content...', 'warning');
        await fs.ensureDir(path.dirname(analysisFilePath));
        await fs.writeFile(analysisFilePath, resultSummary || '# Stage 1 Analysis\n\nAgent did not produce output.', 'utf-8');
      }

      // Advance phase to 2
      await TaskContextManager.updateContext(sessionId, { active_phase: '2' });
      taskContext = await TaskContextManager.getContext(sessionId);
      activePhase = '2';
      onLog?.('🔎 Phase 1 analysis successfully written to Stage1_Analysis.md.', 'success');
    }

    // ────────────────────────────────────────────────────────────────────────
    //  PHASE 2 — Formulating Modernization Strategy (Planner sub-agent)
    //
    //  Phase 2 reads Stage1_Analysis.md and task context from Phase 1,
    //  then writes a detailed migration-plan.md.
    //  Tools: read only + write_file + task context.
    // ────────────────────────────────────────────────────────────────────────
    if (activePhase === '2') {
      onLog?.('⚙️ Phase 2: Formulating Modernization Strategy and Migration Plan...', 'info');

      const plannerPrompt = `Based on the legacy analysis from Phase 1 (see Stage1_Analysis.md and task context), 
formulate a detailed modernization strategy and file-by-file refactoring plan.
Read Stage1_Analysis.md using getFileContent with file="Stage1_Analysis.md", then load the task context 
to access the rules-by-file and file-index.

The target modernization stack selected by the user is:
  - Language: ${targetStack.language}
  - Framework: ${targetStack.framework}
  - Database: ${targetStack.database}
  - Testing Framework: ${targetStack.testFramework}

Write the final plan to "migration-plan.md" in the output workspace.`;

      const phase2Tools = [
        TOOLS_REGISTRY.getFileContent,
        TOOLS_REGISTRY.get_task_context,
        TOOLS_REGISTRY.edit_task_context,
        TOOLS_REGISTRY.write_file,
      ];

      const planSummary = await AgentExecutor.execute(
        aiService,
        plannerPrompt,
        PLANNER_SYSTEM_PROMPT,
        phase2Tools,
        context,
        40
      );

      // ── Fallback for migration-plan.md ───────────────────────────────────
      const planFilePath = path.join(modernPath, 'migration-plan.md');
      if (!(await fs.pathExists(planFilePath))) {
        onLog?.('⚠️ migration-plan.md was not written by the agent. Writing fallback content...', 'warning');
        await fs.ensureDir(path.dirname(planFilePath));
        await fs.writeFile(planFilePath, planSummary || '# Migration Plan\n\nAgent did not produce output.', 'utf-8');
      }

      await TaskContextManager.updateContext(sessionId, { active_phase: 'complete' });
      resultSummary = resultSummary ? `${resultSummary}\n\n${planSummary}` : planSummary;
      onLog?.('⚙️ Phase 2 migration plan successfully written to migration-plan.md.', 'success');
    }

    return resultSummary;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  buildAnalyzerPrompt
//  Constructs the user-facing prompt for the FileAnalyzer sub-agent.
//  KEY RULE: NO target stack. NO "migrate to X". Just: analyze the legacy code.
// ─────────────────────────────────────────────────────────────────────────────
function buildAnalyzerPrompt(legacyPath: string, detectedStack: DetectedStack): string {
  return `Please perform a complete static analysis of the legacy project located at "${legacyPath}".

Your task is to fully understand and document this codebase as it currently exists.
Do NOT suggest any changes or target technologies.

Initial heuristic scan detected:
  - Language: ${detectedStack.language}
  - Framework: ${detectedStack.framework}
  - Database: ${detectedStack.database}
  - Package Manager: ${detectedStack.packageManager}
  - File Count: ${detectedStack.fileCount}

These detections may be approximate — verify them by reading the actual manifest files.

Follow your system prompt workflow exactly:
  1. Load task context to check for any prior progress (LAST_FILE_ANALYZED, file-index).
  2. Call getWorkspaceDirectoryStructure to understand the project layout.
  3. Run Language Profile Detection: find all manifest files via findFilesByPattern.
  4. Build the MANDATORY_FILE_INDEX of all source files and save it via edit_task_context.
  5. Read and analyze every file in the index (use batch-read-files when possible).
  6. Build BUSINESS_RULES_BY_FILE per-file map and save via edit_task_context.
  7. Build DEPENDENCY_MAP via getDependencyTree.
  8. Write the comprehensive "Stage1_Analysis.md" report via write_file.`;
}
