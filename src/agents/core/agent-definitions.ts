

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
  FILE_ANALYSIS_SYSTEM_PROMPT,
} from '../../prompts/file-analysis-prompt.js';

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
      identifier: 'alias:fast-model',   
    }
  ],
  prompts: [
    {
      id: 'codebase-scanner-system',
      defaultVariant: {
        id: 'codebase-scanner-system-default',
        label: 'Scanner System Prompt',
        
        template: SCANNER_SYSTEM_PROMPT,
      }
    }
  ],
  agentSpecificVariables: [
    { name: 'projectPath', description: 'Absolute path to the project to scan.', usedInPrompt: true },
  ],
};

// NOTE: The former `STAGE1_PLANNER_AGENT` ("migration-planner-stage1") was removed.
// It was a legacy unified planner, superseded by the Discovery → Analysis →
// Graph-Resolver → Section-Writer sequence. It was still registered as an invokable
// agent (surfaced via /api/config/agents) even though the pipeline never invoked it,
// and its own description ("generates Stage1_Analysis.md") contradicted its assigned
// prompt (FILE_ANALYSIS_SYSTEM_PROMPT, which states "You never write report documents").
// The analysis phase now uses ANALYSIS_AGENT's tool set directly.

import { agentService } from '../../core/agent-service.js';

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
    FILE_CONTENT_FUNCTION_ID,          
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

AgentRegistry.register(SCANNER_AGENT);
AgentRegistry.register(DISCOVERY_AGENT);
AgentRegistry.register(GRAPH_RESOLVER_AGENT);
AgentRegistry.register(SECTION_WRITER_AGENT);

export const ANALYSIS_AGENT_ID = 'analysis-agent';

export const ANALYSIS_AGENT: AgentDefinition = {
  id: ANALYSIS_AGENT_ID,
  name: 'Analysis Agent',
  description:
    'Unified file analysis agent for Stage 1 Phase 2. ' +
    'Reads all pending source files sequentially and writes to all applicable knowledge graphs. ' +
    'Replaces 5 parallel domain-specific agents. Works across any language or framework.',
  tags: ['analysis', 'stage1', 'phase2'],
  functions: [
    FILE_CONTENT_FUNCTION_ID,
    BATCH_READ_FILES_FUNCTION_ID,
    EXTRACT_FILE_SYMBOLS_FUNCTION_ID,
    SEARCH_IN_WORKSPACE_FUNCTION_ID,
    FIND_FILES_BY_PATTERN_FUNCTION_ID,   // locate imported local files (related_files_rule)
    GET_TASK_CONTEXT_FUNCTION_ID,
    EDIT_TASK_CONTEXT_FUNCTION_ID,
    APPEND_TO_KNOWLEDGE_GRAPH_FUNCTION_ID,
    READ_KNOWLEDGE_GRAPH_FUNCTION_ID,
  ],
  variables: ['legacyPath', 'language', 'framework'],
  languageModelRequirements: [
    { purpose: 'file-analysis', identifier: 'alias:reasoning-model' }
  ],
  prompts: [
    {
      id: 'analysis-agent-system',
      defaultVariant: {
        id: 'analysis-agent-system-default',
        label: 'Analysis Agent System Prompt',
        template: FILE_ANALYSIS_SYSTEM_PROMPT,
      }
    }
  ],
  agentSpecificVariables: [
    { name: 'legacyPath', description: 'Absolute path to the legacy project root.', usedInPrompt: true },
    { name: 'language',   description: 'Detected primary language.',                 usedInPrompt: true },
    { name: 'framework',  description: 'Detected primary framework.',                usedInPrompt: true },
  ],
};

AgentRegistry.register(ANALYSIS_AGENT);

agentService.registerAgent(SCANNER_AGENT);
agentService.registerAgent(DISCOVERY_AGENT);
agentService.registerAgent(GRAPH_RESOLVER_AGENT);
agentService.registerAgent(SECTION_WRITER_AGENT);
agentService.registerAgent(ANALYSIS_AGENT);

export const ALL_AGENT_DEFINITIONS = [
  SCANNER_AGENT,
  DISCOVERY_AGENT,
  ANALYSIS_AGENT,
  GRAPH_RESOLVER_AGENT,
  SECTION_WRITER_AGENT,
];
