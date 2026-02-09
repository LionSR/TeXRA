/**
 * Service interfaces for cycle flows.
 *
 * Cycle services extend BaseFlowContextInit (agent identity + interrupts)
 * and add per-cycle runtime fields (client, state slices, etc.).
 * This eliminates the previous flat re-declaration of ~10 identical fields.
 *
 * Services are injected via PocketFlow's `this.services` (immutable dependencies).
 */

import type { IModelHandler } from '@agent/modelHandlers/types/IModelHandler';
import type {
  AgentRunStateSnapshot,
  ConversationRoundStateSnapshot,
} from '@agent/core/AgentState';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';
import type { TaskRunFileService } from '@utils/files';

// ---------------------------------------------------------------------------
// Shared Types
// ---------------------------------------------------------------------------

/** Callback invoked when a round/cycle completes for usage tracking. */
export type RoundFinalizedCallback = (
  run: AgentRunStateSnapshot,
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Service Interfaces
// ---------------------------------------------------------------------------

/**
 * Services for response cycle flow nodes.
 *
 * Extends BaseFlowContextInit (agent identity + interrupts) with:
 * - client: Model API client (created per cycle via clientRef pattern)
 * - fileService: File I/O for output writing
 * - State slices: run, workspace, round (reconstructed per cycle from snapshots)
 */
export interface ResponseCycleServices<
  C = unknown,
> extends BaseFlowContextInit<C> {
  readonly client: C;
  readonly fileService: TaskRunFileService;
  readonly run: AgentRunStateSnapshot;
  readonly workspace: AgentWorkspaceState;
  round: ConversationRoundStateSnapshot;
}

/** Params for cycle nodes — empty by design (dependencies via services). */
export type CycleParams = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Cycle Service Construction Helper
// ---------------------------------------------------------------------------

/**
 * Build cycle services from outer (flow-level) services.
 *
 * Handles the shared boilerplate:
 * - Lazy client via getter (supports refreshClient without re-setting services)
 * - refreshClient method for token refresh after 401
 * - Spread of outer services as base
 *
 * Callers only provide their cycle-specific overrides.
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
