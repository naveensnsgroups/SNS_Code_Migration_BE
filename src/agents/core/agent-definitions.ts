

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
import {
  MIGRATION_PLANNER_SYSTEM_PROMPT,
} from '../../prompts/migration-planner-prompt.js';
import {
  CODE_GENERATOR_SYSTEM_PROMPT,
} from '../../prompts/code-generator-prompt.js';
import {
  RULE_COVERAGE_SYSTEM_PROMPT,
} from '../../prompts/rule-coverage-prompt.js';
import {
  BUILD_VERIFICATION_SYSTEM_PROMPT,
} from '../../prompts/build-verification-prompt.js';

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
  recoveryHint:
    'Extract this file\'s real data via append-to-knowledge-graph, then mark it DONE ' +
    '(read_status="DONE" in the FILE_INDEX array) via edit_task_context, then move to the next PENDING file.',
};

AgentRegistry.register(ANALYSIS_AGENT);

export const MIGRATION_PLANNER_AGENT_ID = 'migration-planner-agent';

export const MIGRATION_PLANNER_AGENT: AgentDefinition = {
  id: MIGRATION_PLANNER_AGENT_ID,
  name: 'Migration Planner Agent',
  description:
    'Stage 2 planning agent. Assigns a target-stack file path to each legacy file, ' +
    'in dependency order. Dependency order and per-file business-rule associations are ' +
    'already computed deterministically from Stage 1 graphs — this agent only decides ' +
    'target-framework-idiomatic paths, one batch of files at a time.',
  tags: ['migration-planning', 'stage2'],
  functions: [
    GET_TASK_CONTEXT_FUNCTION_ID,
    EDIT_TASK_CONTEXT_FUNCTION_ID,
    READ_KNOWLEDGE_GRAPH_FUNCTION_ID,
  ],
  variables: ['legacyPath'],
  languageModelRequirements: [
    { purpose: 'migration-planning', identifier: 'alias:reasoning-model' }
  ],
  prompts: [
    {
      id: 'migration-planner-system',
      defaultVariant: {
        id: 'migration-planner-system-default',
        label: 'Migration Planner System Prompt',
        template: MIGRATION_PLANNER_SYSTEM_PROMPT,
      }
    }
  ],
  agentSpecificVariables: [
    { name: 'legacyPath', description: 'Absolute path to the legacy project root.', usedInPrompt: true },
  ],
};

AgentRegistry.register(MIGRATION_PLANNER_AGENT);

export const CODE_GENERATOR_AGENT_ID = 'code-generator-agent';

export const CODE_GENERATOR_AGENT: AgentDefinition = {
  id: CODE_GENERATOR_AGENT_ID,
  name: 'Code Generator Agent',
  description:
    'Stage 2 code generation agent. Translates one legacy file into one target-stack ' +
    'file per turn, reading Stage 1 graphs (symbol/rule/api/db/...) as the primary spec ' +
    'and the legacy source as a cross-check. Writes are path-locked server-side to the ' +
    "task list's pre-approved targetFile — the model's own path argument is ignored.",
  tags: ['code-generation', 'stage2'],
  functions: [
    GET_TASK_CONTEXT_FUNCTION_ID,
    READ_KNOWLEDGE_GRAPH_FUNCTION_ID,
    FILE_CONTENT_FUNCTION_ID,
    WRITE_FILE_FUNCTION_ID,
  ],
  variables: ['legacyPath'],
  languageModelRequirements: [
    { purpose: 'code-generation', identifier: 'alias:reasoning-model' }
  ],
  prompts: [
    {
      id: 'code-generator-system',
      defaultVariant: {
        id: 'code-generator-system-default',
        label: 'Code Generator System Prompt',
        template: CODE_GENERATOR_SYSTEM_PROMPT,
      }
    }
  ],
  agentSpecificVariables: [
    { name: 'legacyPath', description: 'Absolute path to the legacy project root.', usedInPrompt: true },
  ],
  recoveryHint: 'Call write_file with the COMPLETE translated file content now, then stop.',
};

AgentRegistry.register(CODE_GENERATOR_AGENT);

export const RULE_COVERAGE_AGENT_ID = 'rule-coverage-agent';

export const RULE_COVERAGE_AGENT: AgentDefinition = {
  id: RULE_COVERAGE_AGENT_ID,
  name: 'Rule Coverage Agent',
  description:
    'Stage 2 verification agent. Given one generated file\'s content and its specific ' +
    'expected business-rule list (from the Rule Coverage Manifest built during planning), ' +
    'judges rule-by-rule whether each rule is still visibly enforced. Cross-checks against ' +
    'the actual legacy source file, not just the rule-graph\'s text description of it — an ' +
    'incomplete or imprecise extraction should not be able to fool this check the same way ' +
    'it could fool the generator that read the same description. The only real check for ' +
    'whether translated code preserved legacy behavior, not just whether it compiles.',
  tags: ['verification', 'stage2'],
  functions: [
    EDIT_TASK_CONTEXT_FUNCTION_ID,
    FILE_CONTENT_FUNCTION_ID,
  ],
  variables: ['legacyPath'],
  languageModelRequirements: [
    { purpose: 'rule-coverage-check', identifier: 'alias:reasoning-model' }
  ],
  prompts: [
    {
      id: 'rule-coverage-system',
      defaultVariant: {
        id: 'rule-coverage-system-default',
        label: 'Rule Coverage System Prompt',
        template: RULE_COVERAGE_SYSTEM_PROMPT,
      }
    }
  ],
  agentSpecificVariables: [
    { name: 'legacyPath', description: 'Absolute path to the legacy project root.', usedInPrompt: true },
  ],
};

AgentRegistry.register(RULE_COVERAGE_AGENT);

export const BUILD_VERIFICATION_AGENT_ID = 'build-verification-agent';

export const BUILD_VERIFICATION_AGENT: AgentDefinition = {
  id: BUILD_VERIFICATION_AGENT_ID,
  name: 'Build Verification Agent',
  description:
    'Stage 2 verification agent. Decides — from its own knowledge of the target language, ' +
    'not a hardcoded per-language table — what dependencies a generated project needs, ' +
    'writes the idiomatic manifest file, installs dependencies for real, and actually ' +
    'attempts to import/build every generated file via capturedShellExecute. Reports the ' +
    'real pass/fail and real error text per file — the only check that catches a bug which ' +
    'only surfaces the moment code actually runs (missing import, undefined name, syntax error).',
  tags: ['verification', 'stage2'],
  functions: [
    FILE_CONTENT_FUNCTION_ID,
    WRITE_FILE_FUNCTION_ID,
    CAPTURED_SHELL_EXECUTION_ID,
    EDIT_TASK_CONTEXT_FUNCTION_ID,
  ],
  variables: ['legacyPath'],
  languageModelRequirements: [
    { purpose: 'build-verification', identifier: 'alias:reasoning-model' }
  ],
  prompts: [
    {
      id: 'build-verification-system',
      defaultVariant: {
        id: 'build-verification-system-default',
        label: 'Build Verification System Prompt',
        template: BUILD_VERIFICATION_SYSTEM_PROMPT,
      }
    }
  ],
  agentSpecificVariables: [
    { name: 'legacyPath', description: 'Absolute path to the legacy project root.', usedInPrompt: true },
  ],
};

AgentRegistry.register(BUILD_VERIFICATION_AGENT);

agentService.registerAgent(SCANNER_AGENT);
agentService.registerAgent(DISCOVERY_AGENT);
agentService.registerAgent(GRAPH_RESOLVER_AGENT);
agentService.registerAgent(SECTION_WRITER_AGENT);
agentService.registerAgent(ANALYSIS_AGENT);
agentService.registerAgent(MIGRATION_PLANNER_AGENT);
agentService.registerAgent(CODE_GENERATOR_AGENT);
agentService.registerAgent(RULE_COVERAGE_AGENT);
agentService.registerAgent(BUILD_VERIFICATION_AGENT);

export const ALL_AGENT_DEFINITIONS = [
  SCANNER_AGENT,
  DISCOVERY_AGENT,
  ANALYSIS_AGENT,
  GRAPH_RESOLVER_AGENT,
  SECTION_WRITER_AGENT,
  MIGRATION_PLANNER_AGENT,
  CODE_GENERATOR_AGENT,
  RULE_COVERAGE_AGENT,
  BUILD_VERIFICATION_AGENT,
];
