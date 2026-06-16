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

import { AgentDefinition, AgentRegistry } from '../../types/agent.js';
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
  APPEND_TO_KNOWLEDGE_GRAPH_FUNCTION_ID,
  READ_KNOWLEDGE_GRAPH_FUNCTION_ID,
} from '../../common/workspace-functions.js';
import {
  SCANNER_SYSTEM_PROMPT,
} from '../../prompts/scanner-prompt.js';
import {
  ANALYZER_SYSTEM_PROMPT,
} from '../../prompts/analyzer-prompt.js';

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
    // NOTE: TODO_WRITE, UPDATE_MIGRATION_DASHBOARD, COMPRESS_MIGRATION_CONTEXT,
    // WRITE_MIGRATION_FILES, FIND_MIGRATION_SESSION, COMPARE_FILES removed —
    // these are not registered in the tool registry and caused noisy warnings.
    BATCH_READ_FILES_FUNCTION_ID,
    GET_TASK_CONTEXT_FUNCTION_ID,
    EDIT_TASK_CONTEXT_FUNCTION_ID,
    WRITE_FILE_FUNCTION_ID,
    APPEND_TO_KNOWLEDGE_GRAPH_FUNCTION_ID,
    READ_KNOWLEDGE_GRAPH_FUNCTION_ID,
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

import { agentService } from '../../core/agent-service.js';

AgentRegistry.register(SCANNER_AGENT);
AgentRegistry.register(STAGE1_PLANNER_AGENT);

agentService.registerAgent(SCANNER_AGENT);
agentService.registerAgent(STAGE1_PLANNER_AGENT);

export const ALL_AGENT_DEFINITIONS = [
  SCANNER_AGENT,
  STAGE1_PLANNER_AGENT,
];

// =============================================================================
//  DISCOVERY AGENT — Stage 1, Phase 1: Workspace Discovery Only
//
//  Job: catalog all source files, detect language/framework, build FILE_INDEX.
//  Does NOT read source file content. Does NOT analyze code.
//  Tools: read-only workspace tools + task context (no knowledge graph tools).
// =============================================================================

export const DISCOVERY_AGENT_ID = 'discovery-agent';

export const DISCOVERY_AGENT: AgentDefinition = {
  id: DISCOVERY_AGENT_ID,
  name: 'Discovery Agent',
  description:
    'Catalogs the legacy workspace: detects monorepo structure, language profiles, ' +
    'asset inventory, and builds the complete FILE_INDEX. ' +
    'Stops after saving FILE_INDEX_KEY and TOTAL_FILES. Does NOT read source code.',
  tags: ['discovery', 'stage1', 'phase1'],
  functions: [
    GET_WORKSPACE_DIRECTORY_STRUCTURE_FUNCTION_ID,
    GET_WORKSPACE_FILE_LIST_FUNCTION_ID,
    FILE_CONTENT_FUNCTION_ID,
    FIND_FILES_BY_PATTERN_FUNCTION_ID,
    GET_DEPENDENCY_TREE_FUNCTION_ID,
    GET_GIT_LOG_FUNCTION_ID,
    GET_ENVIRONMENT_INFO_FUNCTION_ID,
    SCAN_ASSET_FILES_FUNCTION_ID,
    TODO_WRITE_FUNCTION_ID,
    GET_TASK_CONTEXT_FUNCTION_ID,
    EDIT_TASK_CONTEXT_FUNCTION_ID,
  ],
  variables: ['legacyPath'],
  languageModelRequirements: [
    { purpose: 'discovery', identifier: 'alias:reasoning-model' }
  ],
  prompts: [],
  agentSpecificVariables: [
    { name: 'legacyPath', description: 'Absolute path to the legacy project root.', usedInPrompt: true },
  ],
};

// =============================================================================
//  GRAPH RESOLVER AGENT — Stage 1, Phase 3: Cross-Reference Resolution
//
//  Job: resolve FK relationships, call chains, auth requirements, build call
//  flows, and synthesize architecture overview from all knowledge graphs.
//  Tools: knowledge graph read/write + search only (no file reading needed).
// =============================================================================

export const GRAPH_RESOLVER_AGENT_ID = 'graph-resolver-agent';

export const GRAPH_RESOLVER_AGENT: AgentDefinition = {
  id: GRAPH_RESOLVER_AGENT_ID,
  name: 'Graph Resolver Agent',
  description:
    'Resolves cross-file references across knowledge graphs: FK relationships in entity-graph, ' +
    'call chains in symbol-graph, auth requirements in api-graph, ' +
    'builds call-flow-graph, and synthesizes the architecture-graph from all graphs.',
  tags: ['graph-resolution', 'stage1', 'phase3'],
  functions: [
    SEARCH_IN_WORKSPACE_FUNCTION_ID,
    FIND_FILES_BY_PATTERN_FUNCTION_ID,
    GET_WORKSPACE_DIRECTORY_STRUCTURE_FUNCTION_ID,
    FILE_CONTENT_FUNCTION_ID,          // Added: FK resolution needs to READ entity files to confirm definitions
    GET_TASK_CONTEXT_FUNCTION_ID,
    EDIT_TASK_CONTEXT_FUNCTION_ID,
    APPEND_TO_KNOWLEDGE_GRAPH_FUNCTION_ID,
    READ_KNOWLEDGE_GRAPH_FUNCTION_ID,
  ],
  variables: ['legacyPath'],
  languageModelRequirements: [
    { purpose: 'graph-resolution', identifier: 'alias:reasoning-model' }
  ],
  prompts: [],
  agentSpecificVariables: [
    { name: 'legacyPath', description: 'Absolute path to the legacy project root.', usedInPrompt: true },
  ],
};

// =============================================================================
//  SECTION WRITER AGENT — Stage 1, Phase 4: One Section Per Run
//
//  Job: write exactly ONE section of Stage1_Analysis.md from its designated
//  knowledge graph. Each run is a fresh context window — no exhaustion.
//  Tools: read-knowledge-graph + write_file + task context (read only).
// =============================================================================

export const SECTION_WRITER_AGENT_ID = 'section-writer-agent';

export const SECTION_WRITER_AGENT: AgentDefinition = {
  id: SECTION_WRITER_AGENT_ID,
  name: 'Section Writer Agent',
  description:
    'Writes a single section of Stage1_Analysis.md from a designated knowledge graph. ' +
    'Called 26 times (once per section) with a fresh context each time. ' +
    'Reads from the appropriate graph and writes to _analysis/sections/section-NN.md.',
  tags: ['section-writing', 'stage1', 'phase4'],
  functions: [
    GET_TASK_CONTEXT_FUNCTION_ID,
    READ_KNOWLEDGE_GRAPH_FUNCTION_ID,
    WRITE_FILE_FUNCTION_ID,
    GET_WORKSPACE_DIRECTORY_STRUCTURE_FUNCTION_ID,
    GET_DEPENDENCY_TREE_FUNCTION_ID,
    GET_WORKSPACE_FILE_LIST_FUNCTION_ID,
  ],
  variables: ['sectionNumber', 'sectionName', 'modernPath'],
  languageModelRequirements: [
    { purpose: 'documentation-writing', identifier: 'alias:reasoning-model' }
  ],
  prompts: [],
  agentSpecificVariables: [
    { name: 'sectionNumber', description: 'Section number (1-26) to write.', usedInPrompt: true },
    { name: 'sectionName',   description: 'Name of the section.',           usedInPrompt: true },
    { name: 'modernPath',    description: 'Output directory path.',         usedInPrompt: true },
  ],
};

// Register new agents
AgentRegistry.register(DISCOVERY_AGENT);
AgentRegistry.register(GRAPH_RESOLVER_AGENT);
AgentRegistry.register(SECTION_WRITER_AGENT);

agentService.registerAgent(DISCOVERY_AGENT);
agentService.registerAgent(GRAPH_RESOLVER_AGENT);
agentService.registerAgent(SECTION_WRITER_AGENT);

export const ALL_AGENT_DEFINITIONS_V2 = [
  SCANNER_AGENT,
  STAGE1_PLANNER_AGENT,
  DISCOVERY_AGENT,
  GRAPH_RESOLVER_AGENT,
  SECTION_WRITER_AGENT,
];
