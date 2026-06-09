// =============================================================================
//  agent-definitions.ts — Formal Agent Registrations
//
//  Mirrors: snside/packages/ai-ide/src/common/orchestrator-chat-agent.ts
//           snside/packages/ai-ide/src/common/universal-chat-agent.ts
//
//  Every agent used in the platform MUST be declared here.
//  These definitions are used by:
//   - AIConfigTab (UI: shows agent info, tools, model requirements)
//   - MigrationOrchestrator (model resolution + tool filtering)
//   - AgentRegistry (runtime lookup)
// =============================================================================

import { AgentDefinition, AgentRegistry } from '../types/agent.js';
import {
  FILE_CONTENT_FUNCTION_ID,
  GET_WORKSPACE_DIRECTORY_STRUCTURE_FUNCTION_ID,
  GET_WORKSPACE_FILE_LIST_FUNCTION_ID,
  SEARCH_IN_WORKSPACE_FUNCTION_ID,
  FIND_FILES_BY_PATTERN_FUNCTION_ID,
  GET_DEPENDENCY_TREE_FUNCTION_ID,
  GET_GIT_LOG_FUNCTION_ID,
  GET_ENVIRONMENT_INFO_FUNCTION_ID,
  EXTRACT_FILE_SYMBOLS_FUNCTION_ID,
  SCAN_ASSET_FILES_FUNCTION_ID,
  CAPTURED_SHELL_EXECUTION_ID,
  TODO_WRITE_FUNCTION_ID,
  UPDATE_MIGRATION_DASHBOARD_FUNCTION_ID,
  COMPRESS_MIGRATION_CONTEXT_FUNCTION_ID,
  WRITE_MIGRATION_FILES_FUNCTION_ID,
  FIND_MIGRATION_SESSION_FUNCTION_ID,
  COMPARE_FILES_FUNCTION_ID,
  WRITE_FILE_FUNCTION_ID,
  BATCH_READ_FILES_FUNCTION_ID,
  GET_TASK_CONTEXT_FUNCTION_ID,
  EDIT_TASK_CONTEXT_FUNCTION_ID,
} from '../common/workspace-functions.js';
import {
  SCANNER_SYSTEM_PROMPT,
} from '../prompts/scanner-prompt.js';
import {
  ANALYZER_SYSTEM_PROMPT,
} from '../prompts/analyzer-prompt.js';

// =============================================================================
//  SCANNER AGENT — Codebase Discovery (Pre-Stage 1)
//
//  Runs before Stage 1. Rapidly inspects manifests to classify the tech stack.
//  Tools: read-only workspace tools only (no writes).
//  Prompt: imported from prompts/scanner-prompt.ts
// =============================================================================

export const SCANNER_AGENT_ID = 'codebase-scanner';

export const SCANNER_AGENT: AgentDefinition = {
  id: SCANNER_AGENT_ID,
  name: 'Codebase Scanner',
  description:
    'Pre-analysis agent that inspects manifest files and source structure to detect the ' +
    'technology stack (language, framework, database, package manager). ' +
    'Runs before Stage 1 to provide stack context for the migration planner.',
  tags: ['scanner', 'discovery'],
  functions: [
    GET_WORKSPACE_DIRECTORY_STRUCTURE_FUNCTION_ID,
    GET_WORKSPACE_FILE_LIST_FUNCTION_ID,
    FILE_CONTENT_FUNCTION_ID,
    GET_DEPENDENCY_TREE_FUNCTION_ID,
    FIND_FILES_BY_PATTERN_FUNCTION_ID,
  ],
  variables: ['projectPath'],
  languageModelRequirements: [
    {
      purpose: 'stack-detection',
      identifier: 'alias:fast-model',   // Resolved via aliasesConfig in session
    }
  ],
  prompts: [
    {
      id: 'codebase-scanner-system',
      defaultVariant: {
        id: 'codebase-scanner-system-default',
        label: 'Scanner System Prompt',
        // Template is stored in prompts/scanner-prompt.ts — not inlined here
        template: SCANNER_SYSTEM_PROMPT,
      }
    }
  ],
  agentSpecificVariables: [
    { name: 'projectPath', description: 'Absolute path to the project to scan.', usedInPrompt: true },
  ],
};

// =============================================================================
//  STAGE 1 — Migration Planner Agent (Phase 1: Analysis + Phase 2: Planning)
// =============================================================================

export const STAGE1_PLANNER_AGENT_ID = 'migration-planner-stage1';

export const STAGE1_PLANNER_AGENT: AgentDefinition = {
  id: STAGE1_PLANNER_AGENT_ID,
  name: 'Migration Planner (Stage 1)',
  description:
    'Analyzes the legacy codebase, detects the technology stack, classifies files by complexity, ' +
    'and generates `Stage1_Analysis.md` and `migration-plan.md` in the modern output workspace. ' +
    'Uses a two-phase approach: Phase 1 discovers project structure and Phase 2 produces the plan.',
  tags: ['planner', 'analyzer', 'stage1'],
  functions: [
    GET_WORKSPACE_DIRECTORY_STRUCTURE_FUNCTION_ID,
    GET_WORKSPACE_FILE_LIST_FUNCTION_ID,
    FILE_CONTENT_FUNCTION_ID,
    SEARCH_IN_WORKSPACE_FUNCTION_ID,
    FIND_FILES_BY_PATTERN_FUNCTION_ID,
    GET_DEPENDENCY_TREE_FUNCTION_ID,
    GET_GIT_LOG_FUNCTION_ID,
    GET_ENVIRONMENT_INFO_FUNCTION_ID,
    EXTRACT_FILE_SYMBOLS_FUNCTION_ID,
    SCAN_ASSET_FILES_FUNCTION_ID,
    CAPTURED_SHELL_EXECUTION_ID,
    TODO_WRITE_FUNCTION_ID,
    UPDATE_MIGRATION_DASHBOARD_FUNCTION_ID,
    COMPRESS_MIGRATION_CONTEXT_FUNCTION_ID,
    WRITE_MIGRATION_FILES_FUNCTION_ID,
    FIND_MIGRATION_SESSION_FUNCTION_ID,
    GET_TASK_CONTEXT_FUNCTION_ID,
    EDIT_TASK_CONTEXT_FUNCTION_ID,
    WRITE_FILE_FUNCTION_ID,
  ],
  variables: ['sessionId', 'legacyPath', 'modernPath', 'targetStack'],
  languageModelRequirements: [
    {
      purpose: 'analysis',
      identifier: 'alias:reasoning-model',  // Resolved by MigrationOrchestrator
    }
  ],
  prompts: [
    {
      id: 'migration-planner-stage1-system',
      defaultVariant: {
        id: 'migration-planner-stage1-system-default',
        label: 'Stage 1 Planner System Prompt',
        // Template is stored in prompts/analyzer-prompt.ts — not inlined here
        template: ANALYZER_SYSTEM_PROMPT,
      }
    }
  ],
  agentSpecificVariables: [
    { name: 'legacyPath',  description: 'Absolute path to the legacy project root.', usedInPrompt: true },
    { name: 'modernPath',  description: 'Absolute path to the modern output folder.', usedInPrompt: true },
    { name: 'targetStack', description: 'The target technology stack.',               usedInPrompt: true },
    { name: 'sessionId',   description: 'Current migration session identifier.',      usedInPrompt: false },
  ],
};

// =============================================================================
//  Registration — Auto-register all agents on module import
//  Registers into BOTH:
//   - AgentRegistry (existing type registry — used by agents for self-lookup)
//   - agentService  (SNS IDE-standard singleton — used by orchestrator dispatch)
// =============================================================================

import { agentService } from '../core/agent-service.js';

AgentRegistry.register(SCANNER_AGENT);
AgentRegistry.register(STAGE1_PLANNER_AGENT);

agentService.registerAgent(SCANNER_AGENT);
agentService.registerAgent(STAGE1_PLANNER_AGENT);

export const ALL_AGENT_DEFINITIONS = [
  SCANNER_AGENT,
  STAGE1_PLANNER_AGENT,
];
