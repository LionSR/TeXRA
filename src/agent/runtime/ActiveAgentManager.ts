// Local imports - state
import { workspaceSM, WorkspaceStateKey } from '@common/state/stateManager';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import type { ToolState } from '@agent/core/ToolState';

export interface PersistedToolUseAgentState {
  type: 'toolUse';
  agentConfig: AgentConfig;
  agentSetting: AgentSetting;
  agentPrompt: AgentPrompt;
  agentPath: string;
  messages: ProviderMessage[];
  toolState: ToolState | null;
  executionId?: ExecutionId;
}

export class ActiveAgentManager {
  public static async save(state: PersistedToolUseAgentState): Promise<void> {
    await workspaceSM.update(WorkspaceStateKey.ACTIVE_AGENT_STATE, state);
  }

  public static async getState(): Promise<
    PersistedToolUseAgentState | undefined
  > {
    return workspaceSM.get<PersistedToolUseAgentState>(
      WorkspaceStateKey.ACTIVE_AGENT_STATE,
    );
  }

  public static async clear(): Promise<void> {
    await workspaceSM.update(WorkspaceStateKey.ACTIVE_AGENT_STATE, undefined);
  }
}
