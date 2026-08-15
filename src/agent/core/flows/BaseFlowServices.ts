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

/**
 * Immutable per-run tool policy the cycle flows read directly from services.
 *
 * These are the launch-context tool-policy values that previously rode the
 * ambient `RunContext` (`approvalPromptsUnavailable`, `runtimeUnavailableTools`,
 * `stopAfterCycle`). Injecting them as an explicit frozen service field lets
 * the response-cycle and tool-use cycle flows run without an
 * `AsyncLocalStorage` frame — the property an SDK embedder wants.
 */
export interface ToolPolicy {
  /** Hide tools whose approval prompts cannot be answered in this host mode. */
  readonly approvalPromptsUnavailable?: boolean;
  /** Hide tools unavailable because the current host/runtime cannot support them. */
  readonly runtimeUnavailableTools?: readonly string[];
  /** Stop a tool-use execution after one model/tool cycle instead of waiting. */
  readonly stopAfterCycle?: boolean;
}

/** Freeze a tool policy so flows cannot mutate it mid-run. */
export function createToolPolicy(policy: ToolPolicy = {}): ToolPolicy {
  return Object.freeze({ ...policy });
}

export interface AgentCore<C = unknown> {
  /** Run identity and owning session; the same frozen object the ambient `RunContext` carries. */
  readonly runScope: RunScope;
  /**
   * The run's live model handler and model id. Shared by reference with the
   * launch context, so a mid-run switch is visible here without a mirror.
   */
  readonly modelCell: ModelCell<C>;
  /** Immutable per-run tool policy; read by cycle flows instead of the ambient RunContext. */
  readonly toolPolicy: ToolPolicy;
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
