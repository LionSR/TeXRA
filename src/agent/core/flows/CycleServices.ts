/** Service interfaces for cycle flows. */

import type {
  AgentRunStateSnapshot,
  ConversationRoundStateSnapshot,
} from '@agent/core/state/AgentState';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { IToolUseSession } from '@agent/core/flows/IToolUseSession';
import type { BaseFlowContextInit } from '@agent/core/flows/BaseFlowServices';
import type { IModelHandler } from '@agent/types/IModelHandler';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import type { TaskRunFileService } from '@utils/files';

/**
 * The live model-client contract every cycle/round flow shares because each
 * runs a `ModelInvocationNode`.
 *
 * - `client` is the provider SDK client for the run's active model.
 * - `refreshClient` re-fetches it after a mid-run model switch so the retry
 *   path picks up the new handler.
 *
 * Declared here (instead of being supplied implicitly through an erased
 * `setServices` call) so the cycle/round factories can type-check the outer
 * node that bridges these fields in before running the inner flow.
 */
export interface ModelClientServices<C = unknown> {
  readonly client: C;
  readonly refreshClient?: () => Promise<void>;
}

/**
 * Bridge the live model client into a cycle/round services object before the
 * outer node runs the inner flow.
 *
 * The `client` getter and `refreshClient` are defined on the **returned
 * literal** — never spread from a pre-evaluated object — so the relay-401
 * token-refresh path keeps live rebinding: `refreshClient()` re-fetches the
 * provider client after a mid-run model switch and the getter reflects it on
 * the next read. Spreading the result of this call elsewhere would snapshot
 * `client` and silently break that liveness, so callers pass the result
 * straight to `flow.setServices(...)`.
 */
export async function withModelClient<C, T extends object>(
  base: T,
  modelHandler: IModelHandler<ProviderMessage, unknown, SdkToolCall, C>,
): Promise<T & ModelClientServices<C>> {
  let client = await modelHandler.getClient();
  return {
    ...base,
    get client(): C {
      return client;
    },
    async refreshClient(): Promise<void> {
      client = await modelHandler.getClient();
    },
  };
}

/**
 * Shared services for the cycle/round flows: the live model client plus the
 * run-scoped file service and state both inner primitives operate on.
 */
interface CycleRunServices<C = unknown>
  extends BaseFlowContextInit<C>, ModelClientServices<C> {
  readonly fileService: TaskRunFileService;
  readonly run: AgentRunStateSnapshot;
  readonly workspace: AgentWorkspaceState;
}

/** Services for response cycle flow nodes. */
export interface ResponseCycleServices<C = unknown>
  extends CycleRunServices<C> {
  round: ConversationRoundStateSnapshot;
  /**
   * Determines the best textual connector between two strings in a LaTeX
   * document context (empty string, space, or newline).
   */
  readonly bestConnectionMethod: (
    str1: string,
    str2: string,
  ) => Promise<{ connector: string; choice: string }>;
}

/**
 * Services for tool-use round flow nodes.
 *
 * A "round" is one LLM invocation + tool dispatch loop (the inner primitive).
 * The outer session step (ToolUseCycleNode) bridges ToolUseServices into this
 * interface by adding `run`, `workspace`, and the {@link ModelClientServices}
 * fields before running the round.
 */
export interface ToolUseRoundServices<C = unknown> extends CycleRunServices<C> {
  readonly toolRegistry: IToolRegistry;
  /** Session for injecting queued user messages after tool dispatch. */
  readonly session?: IToolUseSession;
  /** Callback when a queued follow-up is consumed (clears UI display). */
  readonly onFollowUpConsumed?: () => void;
}
