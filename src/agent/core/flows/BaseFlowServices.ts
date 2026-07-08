import type { AgentTrace } from '@agent/trace';
import type {
  IModelHandler,
  SdkToolCall,
} from '@agent/modelHandlers/types/IModelHandler';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type {
  AgentPrompt,
  AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/definition/AgentCycleOptions';
import type { AgentRunStateSnapshot } from '@agent/core/state/AgentState';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

/** Callback invoked when a round/cycle completes for usage tracking. */
export type RoundFinalizedCallback = (
  run: AgentRunStateSnapshot,
) => void | Promise<void>;

/** Delegation-scoped policy flags, grouped so they travel together on `AgentCore`. */
interface DelegationPolicy {
  /**
   * Delegation depth: 0 for root (user-initiated), N for a subagent N levels deep.
   * Set by executeAgent from ExecuteAgentOptions.delegationDepth. Used by the
   * tool-use flow to gate delegation tools and by the delegation tool itself
   * to compute the child's depth.
   */
  delegationDepth?: number;
  /** Whether approval or user prompts cannot be answered by the current host. */
  approvalPromptsUnavailable?: boolean;
}

export interface AgentCore<C = unknown> {
  modelHandler: IModelHandler<ProviderMessage, unknown, SdkToolCall, C>;
  config: AgentConfig;
  setting: AgentSetting;
  prompt: AgentPrompt;
  logger: AgentTrace;
  streamStatus: StreamStatusMachine;
  userVarChannels: UserVariableChannels;
  /** Working directory override for subagent tool calls (e.g. a git worktree). */
  workingDirectory?: string;
  delegation?: DelegationPolicy;
  /** Tools unavailable because the current host/runtime cannot support them. */
  runtimeUnavailableTools?: readonly string[];
  /** Initial user row to log after the flow has inserted launch media. */
  initialUserMessageForTranscript?: string;
}

export interface AgentRunIdentity {
  readonly runtimeHost: AgentRuntimeHost;
  readonly streamId: StreamTabId;
  readonly executionId: ExecutionId;
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
