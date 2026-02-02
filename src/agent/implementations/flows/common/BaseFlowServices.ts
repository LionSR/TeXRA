/**
 * Base interfaces for flow context initialization.
 *
 * Hierarchy: AgentCore (identity) -> BaseFlowContextInit (+ interrupts)
 *         -> Flow-specific services (ReflectionServices, ToolUseServices)
 */

import type { IModelHandler } from '@agent/modelHandlers/types/IModelHandler';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { AgentLogger } from '@logger/AgentLogger';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

/** Core agent identity - fields that don't change during execution. */
export interface AgentCore<C = unknown> {
  modelHandler: IModelHandler<any, any, any, any, C>;
  config: AgentConfig;
  setting: AgentSetting;
  prompt: AgentPrompt;
  logger: AgentLogger;
  streamId: StreamTabId;
  executionId: ExecutionId;
  userVarChannels: UserVariableChannels;
}

/** AgentCore + interrupt handling for flow execution. */
export interface BaseFlowContextInit<C = unknown> extends AgentCore<C> {
  checkInterruption: () => boolean;
  setAbortController: (ctrl: AbortController | null) => void;
  onInterrupt?: () => void;
  getUsageRecorder?: () => RoundFinalizedCallback;
}

export interface FlowParams {
  [key: string]: unknown;
}
