// Local imports - state
import { workspaceSM, WorkspaceStateKey } from '@common/state/stateManager';

// Local imports - utils
import { getConfig } from '@utils/config';
import { getStreamTabId } from '@/logger/streamUtils';

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

type PersistedStateMap = Record<string, PersistedToolUseAgentState>;

export class ActiveAgentManager {
  private static computeStreamId(config: AgentConfig): string {
    return getStreamTabId(config.agent, config.model, config.inputFile);
  }

  private static async getAllStates(): Promise<PersistedStateMap> {
    return (
      workspaceSM.get<PersistedStateMap>(
        WorkspaceStateKey.ACTIVE_AGENT_STATE,
        {},
      ) || {}
    );
  }

  public static async save(state: SaveableToolUseAgentState): Promise<void> {
    if (!getConfig<boolean>('agent.persistSessions', true)) return;
    const streamId = this.computeStreamId(state.agentConfig);
    const all = await this.getAllStates();
    all[streamId] = { ...state, timestamp: Date.now() };
    await workspaceSM.update(WorkspaceStateKey.ACTIVE_AGENT_STATE, all);
  }

  public static async getState(
    streamId: string,
  ): Promise<PersistedToolUseAgentState | undefined> {
    if (!getConfig<boolean>('agent.persistSessions', true)) return undefined;
    const all = await this.getAllStates();
    const state = all[streamId];
    if (!state) return undefined;
    try {
      PersistedToolUseAgentStateSchema.parse(state);
    } catch {
      await this.clear(streamId);
      return undefined;
    }
    const ttl = getConfig<number>('agent.sessionTtlHours', 24) * 3600000;
    if (Date.now() - state.timestamp > ttl) {
      await this.clear(streamId);
      return undefined;
    }
    return state;
  }

  public static async getStates(): Promise<PersistedStateMap> {
    if (!getConfig<boolean>('agent.persistSessions', true)) return {};
    const all = await this.getAllStates();
    const ttl = getConfig<number>('agent.sessionTtlHours', 24) * 3600000;
    const now = Date.now();
    let changed = false;
    for (const [id, state] of Object.entries(all)) {
      if (now - state.timestamp > ttl) {
        delete all[id];
        changed = true;
      } else {
        try {
          PersistedToolUseAgentStateSchema.parse(state);
        } catch {
          delete all[id];
          changed = true;
        }
      }
    }
    if (changed) {
      await workspaceSM.update(WorkspaceStateKey.ACTIVE_AGENT_STATE, all);
    }
    return all;
  }

  public static async clear(arg?: string | AgentConfig): Promise<void> {
    const all = await this.getAllStates();
    if (!arg) {
      await workspaceSM.update(WorkspaceStateKey.ACTIVE_AGENT_STATE, {});
      return;
    }
    const streamId = typeof arg === 'string' ? arg : this.computeStreamId(arg);
    delete all[streamId];
    await workspaceSM.update(WorkspaceStateKey.ACTIVE_AGENT_STATE, all);
  }
}
