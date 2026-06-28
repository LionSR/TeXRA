import {
  getRuntimeAgent,
  getRuntimeToolUseAgent,
  getRuntimeWorkflowAgent,
  type RuntimeAgentEntry,
} from '@agent/runtime/agentResolution';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc/mainViewCommands';
import {
  AGENT_SOURCE,
  AgentCategory,
  agentKey,
  agentKeyOf,
  type AgentSource,
} from '@shared/schemas/agent';
import type { SessionType } from '@shared/schemas/mainView/state';

export interface MainViewAgentSelectionDeps {
  readonly getAgent?: (
    agentIdentifier: string,
  ) => RuntimeAgentEntry | undefined;
  readonly getToolUseAgent?: (
    agentIdentifier: string,
  ) => RuntimeAgentEntry | undefined;
  readonly getWorkflowAgent?: (
    agentIdentifier: string,
  ) => RuntimeAgentEntry | undefined;
}

export interface MainViewAgentSelectionMessage {
  readonly command: typeof MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT;
  readonly agentId: string;
  readonly sessionType: SessionType;
}

/**
 * Project runtime agent identity into the main-view selector message.
 *
 * Runtime agent entries are catalog facts. The main webview needs only two
 * facts: the canonical selector value and which selector mode should be active.
 */
export class MainViewAgentSelectionController {
  constructor(private readonly deps: MainViewAgentSelectionDeps = {}) {}

  getSourceAgentSelection(input: {
    source: AgentSource;
    name: string;
  }): MainViewAgentSelectionMessage {
    const requestedKey = agentKey(input.source, input.name);
    const entry = this.getAgent(requestedKey);
    return this.toSelectionMessage(
      entry,
      requestedKey,
      this.getSessionType(entry, input.source),
    );
  }

  getToolUseAgentSelection(
    agentIdentifier: string,
  ): MainViewAgentSelectionMessage {
    const entry = this.getToolUseAgent(agentIdentifier);
    return this.toSelectionMessage(entry, agentIdentifier, 'toolUse');
  }

  getCategoryAgentSelection(input: {
    agentIdentifier: string;
    category: AgentCategory;
  }): MainViewAgentSelectionMessage {
    const entry = this.getCategoryAgent(input.agentIdentifier, input.category);
    return this.toSelectionMessage(
      entry,
      input.agentIdentifier,
      this.getSessionTypeForCategory(input.category),
    );
  }

  private toSelectionMessage(
    entry: RuntimeAgentEntry | undefined,
    fallbackAgentId: string,
    sessionType: SessionType,
  ): MainViewAgentSelectionMessage {
    return {
      command: MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT,
      agentId: entry ? agentKeyOf(entry) : fallbackAgentId,
      sessionType,
    };
  }

  private getAgent(agentIdentifier: string): RuntimeAgentEntry | undefined {
    return (this.deps.getAgent ?? getRuntimeAgent)(agentIdentifier);
  }

  private getToolUseAgent(
    agentIdentifier: string,
  ): RuntimeAgentEntry | undefined {
    return (this.deps.getToolUseAgent ?? getRuntimeToolUseAgent)(
      agentIdentifier,
    );
  }

  private getWorkflowAgent(
    agentIdentifier: string,
  ): RuntimeAgentEntry | undefined {
    return (this.deps.getWorkflowAgent ?? getRuntimeWorkflowAgent)(
      agentIdentifier,
    );
  }

  private getCategoryAgent(
    agentIdentifier: string,
    category: AgentCategory,
  ): RuntimeAgentEntry | undefined {
    return category === AgentCategory.ToolUse
      ? this.getToolUseAgent(agentIdentifier)
      : this.getWorkflowAgent(agentIdentifier);
  }

  private getSessionType(
    entry: RuntimeAgentEntry | undefined,
    source: AgentSource,
  ): SessionType {
    if (entry?.category === AgentCategory.ToolUse) return 'toolUse';
    if (source === AGENT_SOURCE.BUILT_IN_TOOL_USE) return 'toolUse';
    return 'workflow';
  }

  private getSessionTypeForCategory(category: AgentCategory): SessionType {
    return category === AgentCategory.ToolUse ? 'toolUse' : 'workflow';
  }
}
