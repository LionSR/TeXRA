/**
 * Service interfaces and option types for cycle flows.
 * Services are injected via PocketFlow's `this.services` (immutable dependencies).
 */

import type {
  AgentRunState,
  ConversationRoundState,
} from '@agent/core/AgentState';
import type { AgentCycleBaseOptions } from '@agent/core/AgentCycleOptions';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { IToolUseSession } from '@agent/implementations/flows/tooluse/ToolUseSessionLifecycle';
import type { TaskRunFileService } from '@utils/files';

// ---------------------------------------------------------------------------
// State Slices
// ---------------------------------------------------------------------------

/** Callback invoked when a round/cycle completes for usage tracking. */
export type RoundFinalizedCallback = (
  run: AgentRunState,
) => void | Promise<void>;

/** Base state slices common to all cycle flows. */
export interface BaseCycleStateSlices {
  readonly run: AgentRunState;
  readonly workspace: AgentWorkspaceState;
  readonly onRoundFinalized?: RoundFinalizedCallback;
}

/** State slices for response cycle flows (includes round for workflow agents). */
export interface CycleStateSlices extends BaseCycleStateSlices {
  round: ConversationRoundState;
}

// ---------------------------------------------------------------------------
// Cycle Options
// ---------------------------------------------------------------------------

/** Options for response cycle execution (workflow flows). */
export interface ResponseCycleOptions<C = unknown>
  extends AgentCycleBaseOptions<C> {
  config: AgentConfig;
  fileService: TaskRunFileService;
}

/** Options for tool-use cycle execution (interactive flows). */
export interface ToolUseCycleOptions<C = unknown>
  extends AgentCycleBaseOptions<C> {
  toolRegistry: IToolRegistry;
  modelName?: string;
  agentName?: string;
  /** Session for injecting queued user messages after tool dispatch. */
  session?: IToolUseSession;
  /** Callback when a queued follow-up is consumed (clears UI display). */
  onFollowUpConsumed?: () => void;
}

// ---------------------------------------------------------------------------
// Service Containers
// ---------------------------------------------------------------------------

/** Services for response cycle flows. */
export type ResponseCycleServices<C = unknown> = CycleStateSlices &
  Readonly<ResponseCycleOptions<C>>;

/** Services for tool-use cycle flows. */
export type ToolUseCycleServices<C = unknown> = BaseCycleStateSlices &
  Readonly<ToolUseCycleOptions<C>>;

/** Params for response cycle nodes (services injected via `this.services`). */
export type ResponseCycleParams<_C = unknown> = Record<string, unknown>;

/** Params for tool-use cycle nodes (services injected via `this.services`). */
export type ToolUseCycleParams<_C = unknown> = Record<string, unknown>;
