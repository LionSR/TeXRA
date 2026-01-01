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

export interface AgentRoundFinalizedContext {
  round: ConversationRoundState;
  run: AgentRunState;
  workspace: AgentWorkspaceState;
}

export type AgentRoundFinalizedCallback = (
  context: AgentRoundFinalizedContext,
) => void | Promise<void>;

export interface AgentSharedStoreSlices {
  round: ConversationRoundState;
  run: AgentRunState;
  workspace: AgentWorkspaceState;
  user: UserVariableChannels;
}

interface AgentSharedStoreOptions extends AgentSharedStoreSlices {
  onRoundFinalized?: AgentRoundFinalizedCallback;
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
 * Only the active round slice is mutable because flows swap it out between iterations
 * while the run, workspace, and user-variable channels remain stable for the duration
 * of a run.
 */
export class AgentSharedStore {
  private roundState: ConversationRoundState;
  private readonly runState: AgentRunState;
  private readonly workspaceState: AgentWorkspaceState;
  private readonly userChannels: UserVariableChannels;
  private _onRoundFinalized?: AgentRoundFinalizedCallback;
  private _roundFinalized = false;

  constructor(config: AgentSharedStoreOptions) {
    this.roundState = config.round;
    this.runState = config.run;
    this.workspaceState = config.workspace;
    this.userChannels = config.user;
    this._onRoundFinalized = config.onRoundFinalized;
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

  resetRound(roundIndex: number): ConversationRoundState {
    this.roundState = new ConversationRoundState(roundIndex);
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

  /**
   * Set the callback to be called when a round is finalized.
   * Useful for attaching callbacks after deserialization since callbacks
   * are not serialized.
   */
  setOnRoundFinalized(callback: AgentRoundFinalizedCallback | undefined): void {
    this._onRoundFinalized = callback;
  }

  async finalizeRound(): Promise<void> {
    // Guard against double finalization (can happen from error paths + finally blocks)
    if (this._roundFinalized) {
      return;
    }
    this._roundFinalized = true;

    this.runState.recordRound(this.roundState);
    if (this._onRoundFinalized) {
      await this._onRoundFinalized({
        round: this.roundState,
        run: this.runState,
        workspace: this.workspaceState,
      });
    }
  }
}

interface SharedStoreFactoryParams {
  roundIndex: number;
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
  roundState?: ConversationRoundState;
  onRoundFinalized?: AgentRoundFinalizedCallback;
}
type SharedStoreFactoryArgs =
  | (SharedStoreFactoryParams & { snapshot?: undefined })
  | ({
      snapshot: AgentSharedStoreSnapshot;
      onRoundFinalized?: AgentRoundFinalizedCallback;
    } & Partial<Omit<SharedStoreFactoryParams, 'onRoundFinalized'>>);

export function createSharedStore(
  args: SharedStoreFactoryArgs,
): AgentSharedStore {
  if ('snapshot' in args) {
    const snapshot = args.snapshot;
    if (!snapshot) {
      throw new Error('Shared store snapshot is required.');
    }
    const store = AgentSharedStore.fromSnapshot(snapshot);

    // Attach callback post-creation if provided (callbacks are not serialized)
    if (args.onRoundFinalized) {
      store.setOnRoundFinalized(args.onRoundFinalized);
    }
    return store;
  }

  const initialRound =
    args.roundState ?? new ConversationRoundState(args.roundIndex);
  return new AgentSharedStore({
    round: initialRound,
    run: args.runState,
    workspace: args.workspaceState,
    user: args.userChannels,
    onRoundFinalized: args.onRoundFinalized,
  });
}
