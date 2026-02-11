/**
 * Service interfaces for cycle flows.
 *
 * Cycle services extend BaseFlowContextInit (agent identity + interrupts)
 * and add per-cycle runtime fields (client, state slices, etc.).
 */

import type { IModelHandler } from '@agent/modelHandlers/types/IModelHandler';
import type {
  AgentRunStateSnapshot,
  ConversationRoundStateSnapshot,
} from '@agent/core/AgentState';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { IToolUseSession } from '@agent/implementations/flows/tooluse/ToolUseSessionLifecycle';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';
import type { TaskRunFileService } from '@utils/files';

/** Callback invoked when a round/cycle completes for usage tracking. */
export type RoundFinalizedCallback = (
  run: AgentRunStateSnapshot,
) => void | Promise<void>;

/** Services for response cycle flow nodes. */
export interface ResponseCycleServices<
  C = unknown,
> extends BaseFlowContextInit<C> {
  readonly client: C;
  readonly fileService: TaskRunFileService;
  readonly run: AgentRunStateSnapshot;
  readonly workspace: AgentWorkspaceState;
  round: ConversationRoundStateSnapshot;
}

/** Services for tool-use cycle flow nodes. */
export interface ToolUseCycleServices<
  C = unknown,
> extends BaseFlowContextInit<C> {
  readonly client: C;
  readonly toolRegistry: IToolRegistry;
  readonly modelName?: string;
  readonly agentName?: string;
  /** Session for injecting queued user messages after tool dispatch. */
  readonly session?: IToolUseSession;
  /** Callback when a queued follow-up is consumed (clears UI display). */
  readonly onFollowUpConsumed?: () => void;
  readonly run: AgentRunStateSnapshot;
  readonly workspace: AgentWorkspaceState;
}

export type CycleParams = Record<string, unknown>;

/**
 * Build cycle services from outer (flow-level) services.
 * Creates a lazy client via getter and a refreshClient method for token refresh.
 */
export async function buildCycleServices<
  Base extends { modelHandler: IModelHandler<any, any, any, any, C> },
  Overrides extends Record<string, unknown>,
  C,
>(
  baseServices: Base,
  overrides: Overrides,
): Promise<
  Base & Overrides & { readonly client: C; refreshClient: () => Promise<void> }
> {
  const { modelHandler } = baseServices;
  const clientRef = { current: await modelHandler.getClient() };

  return {
    ...baseServices,
    ...overrides,
    get client(): C {
      return clientRef.current;
    },
    async refreshClient(): Promise<void> {
      clientRef.current = await modelHandler.getClient();
    },
  };
}
