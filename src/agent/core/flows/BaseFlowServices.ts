import type { AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type {
  AgentPrompt,
  AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/definition/AgentCycleOptions';
import type { AgentRunStateSnapshot } from '@agent/core/state/AgentState';
import type { ModelCell } from '@agent/runtime/ModelCell';
import type { RunScope } from '@agent/runtime/RunScope';

/** Callback invoked when a round/cycle completes for usage tracking. */
export type RoundFinalizedCallback = (
  run: AgentRunStateSnapshot,
) => void | Promise<void>;

export interface AgentCore<C = unknown> {
  /** Run identity and owning session; the same frozen object the ambient `RunContext` carries. */
  readonly runScope: RunScope;
  /**
   * The run's live model handler and model id. Shared by reference with the
   * launch context, so a mid-run switch is visible here without a mirror.
   */
  readonly modelCell: ModelCell<C>;
  config: AgentConfig;
  setting: AgentSetting;
  prompt: AgentPrompt;
  logger: AgentTrace;
  userVarChannels: UserVariableChannels;
  /** Initial user row to log after the flow has inserted launch media. */
  initialUserMessageForTranscript?: string;
}

export interface BaseFlowContextInit<C = unknown> extends AgentCore<C> {
  onRoundFinalized: RoundFinalizedCallback;
}
