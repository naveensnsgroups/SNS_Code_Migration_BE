

import { AgentDefinition } from '../types/agent.js';

export interface IAgentService {
  registerAgent(agent: AgentDefinition): void;
  unregisterAgent(agentId: string): void;
  getAgent(agentId: string): AgentDefinition | undefined;
  getAllAgents(): AgentDefinition[];
  getEnabledAgents(): AgentDefinition[];
  enableAgent(agentId: string): void;
  disableAgent(agentId: string): void;
  isEnabled(agentId: string): boolean;
}

export class AgentServiceImpl implements IAgentService {
  private agents = new Map<string, AgentDefinition>();
  private disabledAgentIds = new Set<string>();

  registerAgent(agent: AgentDefinition): void {
    if (this.agents.has(agent.id)) {
      console.warn(`[AgentService] Agent "${agent.id}" is already registered — skipping.`);
      return;
    }
    this.agents.set(agent.id, agent);
  }

  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  getAgent(agentId: string): AgentDefinition | undefined {
    return this.agents.get(agentId);
  }

  getAllAgents(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  getEnabledAgents(): AgentDefinition[] {
    return this.getAllAgents().filter(a => this.isEnabled(a.id));
  }

  enableAgent(agentId: string): void {
    this.disabledAgentIds.delete(agentId);
  }

  disableAgent(agentId: string): void {
    this.disabledAgentIds.add(agentId);
  }

  isEnabled(agentId: string): boolean {
    return !this.disabledAgentIds.has(agentId);
  }
}

export const agentService = new AgentServiceImpl();
