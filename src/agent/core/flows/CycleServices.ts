/**
 * Service interfaces for cycle flows.
 *
 * Flattened design: each service interface directly declares all its fields
 * instead of composing through 4 levels of Pick/extend/intersection.
 * This makes it immediately clear what dependencies a cycle node has.
 *
 * Services are injected via PocketFlow's `this.services` (immutable dependencies).
 */

import type { IModelHandler } from '@agent/modelHandlers/types/IModelHandler';
import type {
  AgentRunStateSnapshot,
  ConversationRoundStateSnapshot,
} from '@agent/core/AgentState';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { IToolUseSession } from '@agent/implementations/flows/tooluse/ToolUseSessionLifecycle';
import type { AgentLogger } from '@logger/AgentLogger';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { TaskRunFileService } from '@utils/files';

// ---------------------------------------------------------------------------
// Shared Types
// ---------------------------------------------------------------------------

/** Callback invoked when a round/cycle completes for usage tracking. */
export type RoundFinalizedCallback = (
  run: AgentRunStateSnapshot,
) => void | Promise<void>;

/**
 * State slices for response cycle flows (includes round for workflow agents).
 * Used by ResponseCycleNode to pass reconstructed state into the cycle.
 */
export interface CycleStateSlices {
  readonly run: AgentRunStateSnapshot;
  readonly workspace: AgentWorkspaceState;
  readonly onRoundFinalized?: RoundFinalizedCallback;
  round: ConversationRoundStateSnapshot;
}

// ---------------------------------------------------------------------------
// Service Interfaces (Flat — no intermediate Pick/extend layers)
// ---------------------------------------------------------------------------

/**
 * Services for response cycle flow nodes.
 *
 * All fields are declared directly for readability. The previous 4-level
 * composition chain (AgentCore → BaseFlowContextInit → AgentCycleBaseOptions
 * → ResponseCycleOptions ∩ CycleStateSlices) is flattened here.
 */
export interface ResponseCycleServices<C = unknown> {
  // --- Agent identity (from AgentCore) ---
  readonly modelHandler: IModelHandler<any, any, any, any, C>;
  readonly config: AgentConfig;
  readonly setting: AgentSetting;
  readonly prompt: AgentPrompt;
  readonly logger: AgentLogger;
  readonly streamId: StreamTabId;
  readonly executionId: ExecutionId;
  readonly userVarChannels: UserVariableChannels;

  // --- Interrupt handling ---
  readonly checkInterruption: () => boolean;
  readonly setAbortController: (ctrl: AbortController | null) => void;

  // --- Cycle-specific ---
  readonly client: C;
  readonly fileService: TaskRunFileService;

  // --- State slices (reconstructed per cycle) ---
  readonly run: AgentRunStateSnapshot;
  readonly workspace: AgentWorkspaceState;
  readonly onRoundFinalized?: RoundFinalizedCallback;
  round: ConversationRoundStateSnapshot;
}

/**
 * Services for tool-use cycle flow nodes.
 *
 * Flat interface — all fields declared directly.
 * Tool-use cycles don't have a round snapshot (continuous session model).
 */
export interface ToolUseCycleServices<C = unknown> {
  // --- Agent identity (from AgentCore) ---
  readonly modelHandler: IModelHandler<any, any, any, any, C>;
  readonly setting: AgentSetting;
  readonly prompt: AgentPrompt;
  readonly logger: AgentLogger;
  readonly streamId: StreamTabId;
  readonly executionId: ExecutionId;
  readonly userVarChannels: UserVariableChannels;

  // --- Interrupt handling ---
  readonly checkInterruption: () => boolean;
  readonly setAbortController: (ctrl: AbortController | null) => void;

  // --- Cycle-specific ---
  readonly client: C;
  readonly toolRegistry: IToolRegistry;
  readonly modelName?: string;
  readonly agentName?: string;
  /** Session for injecting queued user messages after tool dispatch. */
  readonly session?: IToolUseSession;
  /** Callback when a queued follow-up is consumed (clears UI display). */
  readonly onFollowUpConsumed?: () => void;

  // --- State slices ---
  readonly run: AgentRunStateSnapshot;
  readonly workspace: AgentWorkspaceState;
  readonly onRoundFinalized?: RoundFinalizedCallback;
}

/** Backwards-compatible alias for consumers that reference the old intermediate type. */
export type ToolUseCycleOptions<C = unknown> = ToolUseCycleServices<C>;

/**
 * Params for cycle nodes (services injected via `this.services`).
 * Empty by design - cycles use services for dependencies, params for flow-specific data.
 */
type CycleParams = Record<string, unknown>;

// Re-export for backward compatibility with existing node definitions
export type ResponseCycleParams<_C = unknown> = CycleParams;
export type ToolUseCycleParams<_C = unknown> = CycleParams;

