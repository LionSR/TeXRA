import type { AgentConfig } from '../../core/AgentConfig';
import type { AgentPrompt, AgentSetting } from '../../core/AgentDataclass';
import type { ToolState } from '../../core/ToolState';
import type { ToolUseCycleOptions } from '../../core/ToolUseCycle';
import type { IModelHandler } from '../../modelHandlers';
import type { ProviderMessage } from '../../modelHandlers/types/ProviderMessage';
import type { ToolDefinition } from '@model';
import type { BaseTool } from '@tools/core/base';
import type { ToolUseSessionSnapshot } from '@agent/toolUse/ToolUseSessionManager';
import type { AgentLogger } from '@logger/AgentLogger';

export type ToolUseResolvedSetting = AgentSetting & { tools: ToolDefinition[] };

export interface ToolUseRunContext<C> {
  modelHandler: IModelHandler<any, any, any, any, C>;
  agentConfig: AgentConfig;
  agentPrompt: AgentPrompt;
  agentSetting: AgentSetting;
  userVars: Record<string, any>;
  toolRegistry: Record<string, BaseTool<any>>;
  resolvedSetting: ToolUseResolvedSetting;
  cycleOptions: ToolUseCycleOptions<C> | null;
  shouldSkipCycle: boolean;
  followUp: string | null;
  waitForFollowUp: () => Promise<string | null>;
  hasQueuedFollowUp: () => boolean;
  enterWaitingState: () => Promise<void>;
  markRunning: () => Promise<void>;
  clearPersistedSnapshot: () => Promise<void>;
  checkInterruption: () => boolean;
  consumeResumeSnapshot: () => ToolUseSessionSnapshot | null;
  getMessages: () => ProviderMessage[];
  setMessages: (messages: ProviderMessage[]) => void;
  getToolState: () => ToolState | null;
  setToolState: (state: ToolState) => void;
  takeClient: () => C;
  setAbortController: (ctrl: AbortController | null) => void;
  logger: AgentLogger;
}
