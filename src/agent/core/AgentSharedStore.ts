// Third-party imports
import { z } from 'zod';

// Local imports - state slices
import {
  AgentRunState,
  ConversationRoundState,
  AgentRunStateSnapshotSchema,
  ConversationRoundStateSnapshotSchema,
} from './AgentState';
import {
  AgentWorkspaceState,
  AgentWorkspaceStateSnapshotSchema,
} from './AgentWorkspaceState';
import {
  UserVariableChannelsSchema,
  type UserVariableChannels,
} from './AgentCycleOptions';

// ============================================================================
// Store Slices
// ============================================================================

/**
 * Required slices for all stores.
 */
export interface BaseStoreSlices {
  run: AgentRunState;
  workspace: AgentWorkspaceState;
  user: UserVariableChannels;
}

/**
 * Full store slices including round (for reflection agents).
 */
export interface AgentSharedStoreSlices extends BaseStoreSlices {
  round: ConversationRoundState;
}

// ============================================================================
// Snapshot Schemas
// ============================================================================

/**
 * Base snapshot schema without round.
 * Used by tool-use agents which don't track rounds.
 */
export const BaseStoreSnapshotSchema = z.object({
  run: AgentRunStateSnapshotSchema,
  workspace: AgentWorkspaceStateSnapshotSchema,
  user: UserVariableChannelsSchema,
});

/**
 * Full snapshot schema with optional round.
 * Uses z.object() for backward compatibility with legacy snapshots.
 * Round is optional to support both reflection (with round) and tool-use (without).
 */
export const AgentSharedStoreSnapshotSchema = BaseStoreSnapshotSchema.extend({
  round: ConversationRoundStateSnapshotSchema.optional(),
});

/**
 * Output type for store serialization (without round).
 */
export type BaseStoreSnapshot = z.output<typeof BaseStoreSnapshotSchema>;

/**
 * Output type for AgentSharedStore serialization (with optional round).
 */
export type AgentSharedStoreSnapshot = z.output<
  typeof AgentSharedStoreSnapshotSchema
>;

// Alias for tool-use compatibility (same as BaseStoreSnapshot)
export type ToolUseStoreSnapshot = BaseStoreSnapshot;
export const ToolUseStoreSnapshotSchema = BaseStoreSnapshotSchema;

// ============================================================================
// Store Class
// ============================================================================

/**
 * Central store wiring agent run, workspace, user, and optionally round slices.
 *
 * This is a pure data holder for snapshot serialization. Round finalization logic
 * lives in CycleServices.finalizeRound() as the single source of truth.
 *
 * ## Usage Modes
 *
 * - **Reflection agents**: Use with round for multi-turn tracking
 * - **Tool-use agents**: Use without round (metrics tracked in flow state)
 */
export class AgentSharedStore {
  private roundState: ConversationRoundState | null;
  private readonly runState: AgentRunState;
  private readonly workspaceState: AgentWorkspaceState;
  private readonly userChannels: UserVariableChannels;

  constructor(
    config: BaseStoreSlices & { round?: ConversationRoundState | null },
  ) {
    this.roundState = config.round ?? null;
    this.runState = config.run;
    this.workspaceState = config.workspace;
    this.userChannels = config.user;
  }

  /** Deserialize from a snapshot. Validates and applies schema defaults. */
  static fromSnapshot(snapshot: unknown): AgentSharedStore {
    const parsed = AgentSharedStoreSnapshotSchema.parse(snapshot);
    return new AgentSharedStore({
      round: parsed.round
        ? ConversationRoundState.fromSnapshot(parsed.round)
        : null,
      run: AgentRunState.fromSnapshot(parsed.run),
      workspace: AgentWorkspaceState.fromSnapshot(parsed.workspace),
      user: {
        input: Object.freeze({ ...parsed.user.input }),
        transient: { ...parsed.user.transient },
      },
    });
  }

  /** Serialize to a snapshot. Includes round only if present. */
  toSnapshot(): AgentSharedStoreSnapshot {
    const base: BaseStoreSnapshot = {
      run: this.runState.toSnapshot(),
      workspace: this.workspaceState.toSnapshot(),
      user: {
        input: { ...this.userChannels.input },
        transient: { ...this.userChannels.transient },
      },
    };

    if (this.roundState) {
      return {
        ...base,
        round: this.roundState.toSnapshot(),
      };
    }

    return base;
  }

  /**
   * Get round state. Returns null for tool-use agents.
   * For reflection agents, use hasRound() to check before accessing.
   */
  get round(): ConversationRoundState | null {
    return this.roundState;
  }

  /** Check if this store has a round (reflection agent). */
  hasRound(): boolean {
    return this.roundState !== null;
  }

  get run(): AgentRunState {
    return this.runState;
  }

  get workspace(): AgentWorkspaceState {
    return this.workspaceState;
  }

  get user(): UserVariableChannels {
    return this.userChannels;
  }
}

// Type alias for tool-use compatibility
export type ToolUseStore = AgentSharedStore;

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Factory params for creating a new store with round (reflection agents).
 */
interface SharedStoreWithRoundParams {
  roundIndex: number;
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
  roundState?: ConversationRoundState;
}

/**
 * Factory params for creating a new store without round (tool-use agents).
 */
interface SharedStoreWithoutRoundParams {
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
}

/**
 * Factory args - either create from params or restore from snapshot.
 */
type SharedStoreFactoryArgs =
  | (SharedStoreWithRoundParams & { snapshot?: undefined })
  | { snapshot: AgentSharedStoreSnapshot };

/**
 * Create an AgentSharedStore with round support (for reflection agents).
 */
export function createSharedStore(
  args: SharedStoreFactoryArgs,
): AgentSharedStore {
  if ('snapshot' in args && args.snapshot) {
    return AgentSharedStore.fromSnapshot(args.snapshot);
  }

  const params = args as SharedStoreWithRoundParams;
  const initialRound =
    params.roundState ?? new ConversationRoundState(params.roundIndex);
  return new AgentSharedStore({
    round: initialRound,
    run: params.runState,
    workspace: params.workspaceState,
    user: params.userChannels,
  });
}

/**
 * Factory args for tool-use store.
 */
type ToolUseStoreFactoryArgs =
  | (SharedStoreWithoutRoundParams & { snapshot?: undefined })
  | { snapshot: BaseStoreSnapshot };

/**
 * Create an AgentSharedStore without round (for tool-use agents).
 * This is a convenience function that creates a store with round=null.
 */
export function createToolUseStore(
  args: ToolUseStoreFactoryArgs,
): AgentSharedStore {
  if ('snapshot' in args && args.snapshot) {
    return AgentSharedStore.fromSnapshot(args.snapshot);
  }

  const params = args as SharedStoreWithoutRoundParams;
  return new AgentSharedStore({
    round: null,
    run: params.runState,
    workspace: params.workspaceState,
    user: params.userChannels,
  });
}
