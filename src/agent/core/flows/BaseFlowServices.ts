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
  /**
   * Derived view of {@link abortSignal} for call sites that only ask "was this
   * run interrupted?". Both come from the run's single interrupt controller
   * (`createInterruptCallbacks`), so they can never disagree.
   */
  checkInterruption: () => boolean;
  /**
   * The run's cancellation signal, owned by the one interrupt controller for
   * the whole execution. Nodes pass it into provider calls and tool calls
   * instead of registering controllers of their own.
   */
  readonly abortSignal: AbortSignal;
  onInterrupt?: () => void;
  onRoundFinalized: RoundFinalizedCallback;
}
