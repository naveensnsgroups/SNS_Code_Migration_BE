// =============================================================================
//  agent.ts — SNS IDE Standard Agent Definition Types
//
//  Mirrors: snside/packages/ai-core/src/common/agent.ts
//
//  Every agent in our platform must implement AgentDefinition.
//  This enables the AI Configuration Panel to list agents, their tools,
//  their prompt templates, and their model requirements.
// =============================================================================

// ── Language Model Requirement ────────────────────────────────────────────────
// Mirrors SNS IDE LanguageModelRequirement

/**
 * Declares which language model an agent needs and for what purpose.
 * Mirrors SNS IDE LanguageModelRequirement.
 */
export interface LanguageModelRequirement {
  /**
   * Human-readable purpose label (e.g. 'analysis', 'planning', 'code-generation').
   * Used in the AI Config panel and for alias resolution.
   */
  purpose: string;
  /**
   * Optional preferred model identifier (e.g. 'google/gemini-2.0-flash').
   * If prefixed with 'alias:', the orchestrator resolves it via aliasesConfig.
   */
  identifier?: string;
}

// ── Agent-Specific Variable ───────────────────────────────────────────────────

/** Documents a context variable available to this agent's prompts. */
export interface AgentSpecificVariable {
  name: string;
  description: string;
  /** True if the variable is referenced in the prompt template. */
  usedInPrompt: boolean;
}

// ── Prompt Variant ────────────────────────────────────────────────────────────

/** A single prompt template variant. */
export interface PromptVariant {
  /** Unique ID for this variant (e.g. 'migration-planner-phase1-system'). */
  id: string;
  /** The prompt template text. May contain {{variable}} placeholders. */
  template: string;
  /** Human-readable label for this variant. */
  label?: string;
}

/** A set of prompt variants for a given prompt slot. */
export interface PromptVariantSet {
  /** Prompt slot ID (e.g. 'phase1-system-prompt'). */
  id: string;
  /** The built-in default variant. */
  defaultVariant: PromptVariant;
  /** Optional user-customizable alternative variants. */
  variants?: PromptVariant[];
}

// ── Agent Definition ──────────────────────────────────────────────────────────

/**
 * Formal definition of an agent.
 *
 * Mirrors SNS IDE Agent interface from agent.ts. Every agent in our platform
 * must export a constant implementing this interface.
 *
 * Used by:
 *  - AIConfigTab to display agents, their tools, and prompts
 *  - MigrationOrchestrator to resolve models and tools per agent
 *  - AgentExecutor to validate tool lists against declarations
 */
export interface AgentDefinition {
  /** Unique stable identifier (e.g. 'migration-planner-stage1'). */
  readonly id: string;

  /** Human-readable display name shown in the UI. */
  readonly name: string;

  /** Markdown description of what this agent does. */
  readonly description: string;

  /**
   * The tool IDs this agent uses.
   * Must match constants from tool-ids.ts exactly.
   * Mirrors SNS IDE Agent.functions[].
   */
  readonly functions: string[];

  /**
   * Global variable IDs available to this agent.
   * Mirrors SNS IDE Agent.variables[].
   */
  readonly variables: string[];

  /**
   * Which language model(s) this agent requires and for what purpose.
   * Mirrors SNS IDE Agent.languageModelRequirements[].
   */
  readonly languageModelRequirements: LanguageModelRequirement[];

  /**
   * Prompt templates introduced and used by this agent.
   * Mirrors SNS IDE Agent.prompts[].
   */
  readonly prompts: PromptVariantSet[];

  /** Optional tags for filtering/display ('planner', 'analyzer', 'writer'). */
  readonly tags?: string[];

  /** Context variables specific to this agent. */
  readonly agentSpecificVariables: AgentSpecificVariable[];
}

// ── Agent Registry ─────────────────────────────────────────────────────────────

/**
 * Simple in-memory registry for agent definitions.
 * Mirrors SNS IDE AgentService pattern (simplified, no DI).
 */
export class AgentRegistry {
  private static agents = new Map<string, AgentDefinition>();

  static register(agent: AgentDefinition): void {
    if (this.agents.has(agent.id)) {
      console.warn(`[AgentRegistry] Agent '${agent.id}' already registered — overwriting.`);
    }
    this.agents.set(agent.id, agent);
  }

  static get(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  static getAll(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  static unregister(id: string): void {
    this.agents.delete(id);
  }
}
