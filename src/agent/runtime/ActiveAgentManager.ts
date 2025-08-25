// Local imports - state
import { workspaceSM, WorkspaceStateKey } from '@common/state/stateManager';

// Local imports - utils
import { getConfig } from '@utils/config';

// Third-party imports
import { z } from 'zod';

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
  timestamp: number;
}

export type SaveableToolUseAgentState = Omit<
  PersistedToolUseAgentState,
  'timestamp'
>;

const PersistedToolUseAgentStateSchema = z.object({
  type: z.literal('toolUse'),
  agentConfig: z.any(),
  agentSetting: z.any(),
  agentPrompt: z.any(),
  agentPath: z.string(),
  messages: z.array(z.any()),
  toolState: z.any().nullable(),
  executionId: z.any().optional(),
  timestamp: z.number(),
});

export class ActiveAgentManager {
  public static async save(state: SaveableToolUseAgentState): Promise<void> {
    if (!getConfig<boolean>('agent.persistSessions', true)) return;
    const toSave = { ...state, timestamp: Date.now() };
    await workspaceSM.update(WorkspaceStateKey.ACTIVE_AGENT_STATE, toSave);
  }

  public static async getState(): Promise<
    PersistedToolUseAgentState | undefined
  > {
    if (!getConfig<boolean>('agent.persistSessions', true)) return undefined;
    const raw = workspaceSM.get<any>(WorkspaceStateKey.ACTIVE_AGENT_STATE);
    if (!raw) return undefined;
    let parsed: PersistedToolUseAgentState;
    try {
      parsed = PersistedToolUseAgentStateSchema.parse(
        raw,
      ) as PersistedToolUseAgentState;
    } catch {
      return undefined;
    }
    const ttl = getConfig<number>('agent.sessionTtlHours', 24) * 3600000;
    if (Date.now() - parsed.timestamp > ttl) {
      await this.clear();
      return undefined;
    }
    return parsed;
  }

  public static async clear(): Promise<void> {
    await workspaceSM.update(WorkspaceStateKey.ACTIVE_AGENT_STATE, undefined);
  }
}
