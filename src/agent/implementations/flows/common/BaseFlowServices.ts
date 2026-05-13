import type { IModelHandler } from '@agent/modelHandlers/types/IModelHandler';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { AgentLogger } from '@logger/AgentLogger';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { NestedDelegationConfig } from '@shared/constants/delegationPolicy';

export interface AgentCore<C = unknown> {
  modelHandler: IModelHandler<any, any, any, any, C>;
  config: AgentConfig;
  setting: AgentSetting;
  prompt: AgentPrompt;
  logger: AgentLogger;
  runtimeHost: AgentRuntimeHost;
  streamId: StreamTabId;
  executionId: ExecutionId;
  userVarChannels: UserVariableChannels;
  /** Working directory override for subagent tool calls (e.g. a git worktree). */
  workingDirectory?: string;
  /**
   * Delegation depth: 0 for root (user-initiated), N for a subagent N levels deep.
   * Set by executeAgent from ExecuteAgentOptions.delegationDepth. Used by the
   * tool-use flow to gate delegation tools and by the delegation tool itself
   * to compute the child's depth.
   */
  delegationDepth?: number;
  /**
   * Delegation policy snapshot for this agent run. Tool-use flows set this once
   * so the visible tool list and runtime delegation gate derive from the same
   * max-depth setting without carrying a second depth value.
   */
  delegationConfig?: NestedDelegationConfig;
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
