

export interface LanguageModelRequirement {
  
  purpose: string;
  
  identifier?: string;
}

export interface AgentSpecificVariable {
  name: string;
  description: string;
  
  usedInPrompt: boolean;
}

export interface PromptVariant {
  
  id: string;
  
  template: string;
  
  label?: string;
}

export interface PromptVariantSet {
  
  id: string;
  
  defaultVariant: PromptVariant;
  
  variants?: PromptVariant[];
}

export interface AgentDefinition {
  
  readonly id: string;

  
  readonly name: string;

  
  readonly description: string;

  
  readonly functions: string[];

  
  readonly variables: string[];

  
  readonly languageModelRequirements: LanguageModelRequirement[];

  
  readonly prompts: PromptVariantSet[];

  
  readonly tags?: string[];


  readonly agentSpecificVariables: AgentSpecificVariable[];

  // Optional agent-authored guidance for the harness's stuck-agent recovery system —
  // the one real, specific fix for THIS agent when it loops/stalls (e.g. "call
  // write_file with the complete content, then stop"). When absent, the harness
  // falls back to fully generic guidance derived from this agent's own real tool
  // list — never a hardcoded assumption borrowed from a different agent.
  readonly recoveryHint?: string;
}

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
