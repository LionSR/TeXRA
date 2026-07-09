import type { AgentTrace } from '@agent/trace';
import type { IModelHandler, SdkToolCall } from '@agent/types/IModelHandler';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type {
  AgentPrompt,
  AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/definition/AgentCycleOptions';
import type { AgentRunStateSnapshot } from '@agent/core/state/AgentState';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';

/** Callback invoked when a round/cycle completes for usage tracking. */
export type RoundFinalizedCallback = (
  run: AgentRunStateSnapshot,
) => void | Promise<void>;

export interface AgentCore<C = unknown> {
  modelHandler: IModelHandler<ProviderMessage, unknown, SdkToolCall, C>;
  config: AgentConfig;
  setting: AgentSetting;
  prompt: AgentPrompt;
  logger: AgentTrace;
  streamStatus: StreamStatusMachine;
  userVarChannels: UserVariableChannels;
  /** Initial user row to log after the flow has inserted launch media. */
  initialUserMessageForTranscript?: string;
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
