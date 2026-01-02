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

export interface AgentSharedStoreSlices {
  round: ConversationRoundState;
  run: AgentRunState;
  workspace: AgentWorkspaceState;
  user: UserVariableChannels;
}

// ============================================================================
// ToolUseStore - Simplified store for tool-use agents (no round tracking)
// ============================================================================

/**
 * Store slices for tool-use agents.
 * Unlike AgentSharedStoreSlices, this doesn't include round since tool-use
 * agents track cycle metrics directly in flow state, not via round objects.
 */
export interface ToolUseStoreSlices {
  run: AgentRunState;
  workspace: AgentWorkspaceState;
  user: UserVariableChannels;
}

/**
 * Snapshot schema for ToolUseStore.
 * Uses z.object() for backward compatibility with legacy snapshots.
 */
export const ToolUseStoreSnapshotSchema = z.object({
  run: AgentRunStateSnapshotSchema,
  workspace: AgentWorkspaceStateSnapshotSchema,
  user: UserVariableChannelsSchema,
});

/**
 * Output type for ToolUseStore serialization.
 */
export type ToolUseStoreSnapshot = z.output<typeof ToolUseStoreSnapshotSchema>;

/**
 * Simplified store for tool-use agents.
 *
 * Unlike AgentSharedStore, this doesn't include a round object since tool-use
 * agents track cycle metrics (cycleIndex, cycleResponseTimeMs, etc.) directly
 * in ToolUseCycleState, not via ConversationRoundState.
 */
export class ToolUseStore {
  private readonly runState: AgentRunState;
  private readonly workspaceState: AgentWorkspaceState;
  private readonly userChannels: UserVariableChannels;

  constructor(config: ToolUseStoreSlices) {
    this.runState = config.run;
    this.workspaceState = config.workspace;
    this.userChannels = config.user;
  }

  /** Deserialize from a snapshot. Validates and applies schema defaults. */
  static fromSnapshot(snapshot: unknown): ToolUseStore {
    const parsed = ToolUseStoreSnapshotSchema.parse(snapshot);
    return new ToolUseStore({
      run: AgentRunState.fromSnapshot(parsed.run),
      workspace: AgentWorkspaceState.fromSnapshot(parsed.workspace),
      user: {
        input: Object.freeze({ ...parsed.user.input }),
        transient: { ...parsed.user.transient },
      },
    });
  }

  /** Serialize to a snapshot. */
  toSnapshot(): ToolUseStoreSnapshot {
    return {
      run: this.runState.toSnapshot(),
      workspace: this.workspaceState.toSnapshot(),
      user: {
        input: { ...this.userChannels.input },
        transient: { ...this.userChannels.transient },
      },
    };
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

/**
 * Factory params for creating a new ToolUseStore.
 */
interface ToolUseStoreFactoryParams {
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
}

/**
 * Factory args - either create from params or restore from snapshot.
 */
type ToolUseStoreFactoryArgs =
  | (ToolUseStoreFactoryParams & { snapshot?: undefined })
  | { snapshot: ToolUseStoreSnapshot };

/**
 * Create a ToolUseStore from params or snapshot.
 */
export function createToolUseStore(args: ToolUseStoreFactoryArgs): ToolUseStore {
  if ('snapshot' in args && args.snapshot) {
    return ToolUseStore.fromSnapshot(args.snapshot);
  }

  const params = args as ToolUseStoreFactoryParams;
  return new ToolUseStore({
    run: params.runState,
    workspace: params.workspaceState,
    user: params.userChannels,
  });
}

/**
 * We use z.object() instead of z.strictObject() to remain backward compatible
 * with legacy store snapshots that may contain removed or renamed fields.
 */
export const AgentSharedStoreSnapshotSchema = z.object({
  round: ConversationRoundStateSnapshotSchema,
  run: AgentRunStateSnapshotSchema,
  workspace: AgentWorkspaceStateSnapshotSchema,
  user: UserVariableChannelsSchema,
});

/**
 * Output type for AgentSharedStore serialization.
 * Uses z.output<> to get the type after parsing (all fields required).
 */
export type AgentSharedStoreSnapshot = z.output<
  typeof AgentSharedStoreSnapshotSchema
>;

/**
 * Central store wiring agent run, round, workspace, and user-variable slices together.
 *
 * This is a pure data holder for snapshot serialization. Round finalization logic
 * lives in CycleServices.finalizeRound() as the single source of truth.
 */
export class AgentSharedStore {
  private roundState: ConversationRoundState;
  private readonly runState: AgentRunState;
  private readonly workspaceState: AgentWorkspaceState;
  private readonly userChannels: UserVariableChannels;

  constructor(config: AgentSharedStoreSlices) {
    this.roundState = config.round;
    this.runState = config.run;
    this.workspaceState = config.workspace;
    this.userChannels = config.user;
  }

  /** Deserialize from a snapshot. Validates and applies schema defaults. */
  static fromSnapshot(snapshot: unknown): AgentSharedStore {
    const parsed = AgentSharedStoreSnapshotSchema.parse(snapshot);
    return new AgentSharedStore({
      round: ConversationRoundState.fromSnapshot(parsed.round),
      run: AgentRunState.fromSnapshot(parsed.run),
      workspace: AgentWorkspaceState.fromSnapshot(parsed.workspace),
      user: {
        input: Object.freeze({ ...parsed.user.input }),
        transient: { ...parsed.user.transient },
      },
    });
  }

  /** Serialize to a snapshot. */
  toSnapshot(): AgentSharedStoreSnapshot {
    return {
      round: this.roundState.toSnapshot(),
      run: this.runState.toSnapshot(),
      workspace: this.workspaceState.toSnapshot(),
      user: {
        input: { ...this.userChannels.input },
        transient: { ...this.userChannels.transient },
      },
    };
  }

  get round(): ConversationRoundState {
    return this.roundState;
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

/**
 * Factory params for creating a new store from scratch.
 */
interface SharedStoreFactoryParams {
  roundIndex: number;
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
  roundState?: ConversationRoundState;
}

/**
 * Factory args - either create from params or restore from snapshot.
 */
type SharedStoreFactoryArgs =
  | (SharedStoreFactoryParams & { snapshot?: undefined })
  | { snapshot: AgentSharedStoreSnapshot };

/**
 * Create an AgentSharedStore from params or snapshot.
 *
 * This is the preferred way to create stores as it handles both
 * fresh creation and snapshot restoration.
 */
export function createSharedStore(
  args: SharedStoreFactoryArgs,
): AgentSharedStore {
  if ('snapshot' in args && args.snapshot) {
    return AgentSharedStore.fromSnapshot(args.snapshot);
  }

  // Type narrowing: must be SharedStoreFactoryParams
  const params = args as SharedStoreFactoryParams;
  const initialRound =
    params.roundState ?? new ConversationRoundState(params.roundIndex);
  return new AgentSharedStore({
    round: initialRound,
    run: params.runState,
    workspace: params.workspaceState,
    user: params.userChannels,
  });
}
