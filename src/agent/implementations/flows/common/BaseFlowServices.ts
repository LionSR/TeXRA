import type { IModelHandler } from '@agent/modelHandlers/types/IModelHandler';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { AgentLogger } from '@logger/AgentLogger';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

export interface AgentCore<C = unknown> {
  modelHandler: IModelHandler<any, any, any, any, C>;
  config: AgentConfig;
  setting: AgentSetting;
  prompt: AgentPrompt;
  logger: AgentLogger;
  streamId: StreamTabId;
  executionId: ExecutionId;
  userVarChannels: UserVariableChannels;
  /** Working directory override for subagent tool calls (e.g. a git worktree). */
  workingDirectory?: string;
}

export interface BaseFlowContextInit<C = unknown> extends AgentCore<C> {
  checkInterruption: () => boolean;
  setAbortController: (ctrl: AbortController | null) => void;
  onInterrupt?: () => void;
  onRoundFinalized?: RoundFinalizedCallback;
}

export interface FlowParams {
  [key: string]: unknown;
}
