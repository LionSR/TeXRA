/**
 * Service interfaces for cycle flows.
 *
 * Cycle services extend BaseFlowContextInit (agent identity + interrupts)
 * and add per-cycle runtime fields (client, state slices, etc.).
 * This eliminates the previous flat re-declaration of ~10 identical fields.
 *
 * Services are injected via PocketFlow's `this.services` (immutable dependencies).
 */

import type {
  AgentRunStateSnapshot,
  ConversationRoundStateSnapshot,
} from '@agent/core/AgentState';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { IToolUseSession } from '@agent/implementations/flows/tooluse/ToolUseSessionLifecycle';
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

/**
 * Services for tool-use cycle flow nodes.
 *
 * Extends BaseFlowContextInit (agent identity + interrupts) with:
 * - client: Model API client
 * - toolRegistry + resolved tool names
 * - State slices: run, workspace (no per-round snapshot — continuous session model)
 */
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

/** Params for cycle nodes — empty by design (dependencies via services). */
export type CycleParams = Record<string, unknown>;
