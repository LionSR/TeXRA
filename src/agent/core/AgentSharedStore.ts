// Third-party imports
import { z } from 'zod';

// Local imports - state slices
import {
  AgentRunState,
  AgentRunStateCodec,
  ConversationRoundState,
  ConversationRoundStateCodec,
  AgentRunStateSnapshotSchema,
  ConversationRoundStateSnapshotSchema,
} from './AgentState';
import {
  AgentWorkspaceState,
  AgentWorkspaceStateCodec,
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

  constructor(config: AgentSharedStoreOptions) {
    this.roundState = config.round;
    this.runState = config.run;
    this.workspaceState = config.workspace;
    this.userChannels = config.user;
    this._onRoundFinalized = config.onRoundFinalized;
  }

  get round(): ConversationRoundState {
    return this.roundState;
  }

  setRound(roundState: ConversationRoundState): void {
    this.roundState = roundState;
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

/**
 * Codec for bi-directional serialization of AgentSharedStore.
 * Use .encode() to serialize and .decode() to deserialize.
 *
 * Note: The onRoundFinalized callback is not serialized as it's runtime-only.
 * Use AgentSharedStoreCodec.decode() then set the callback separately if needed.
 */
export const AgentSharedStoreCodec = z.codec(
  AgentSharedStoreSnapshotSchema,
  z.instanceof(AgentSharedStore),
  {
    // Validation and defaults are applied by nested codecs (each parses its own schema).
    // No top-level parse needed here since we delegate to specialized codecs.
    decode: (snapshot): AgentSharedStore => {
      const round = ConversationRoundStateCodec.decode(snapshot.round);
      const run = AgentRunStateCodec.decode(snapshot.run);
      const workspace = AgentWorkspaceStateCodec.decode(snapshot.workspace);
      const storeUserChannels: UserVariableChannels = {
        input: Object.freeze({ ...snapshot.user.input }),
        transient: { ...snapshot.user.transient },
        output: { ...snapshot.user.output },
      };

      return new AgentSharedStore({
        round,
        run,
        workspace,
        user: storeUserChannels,
      });
    },
    encode: (store): AgentSharedStoreSnapshot => ({
      round: ConversationRoundStateCodec.encode(store.round) as AgentSharedStoreSnapshot['round'],
      run: AgentRunStateCodec.encode(store.run) as AgentSharedStoreSnapshot['run'],
      workspace: AgentWorkspaceStateCodec.encode(store.workspace) as AgentSharedStoreSnapshot['workspace'],
      user: {
        input: { ...store.user.input },
        transient: { ...store.user.transient },
        output: { ...store.user.output },
      },
    }),
  },
);

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
    // Codec decode handles validation via nested schema parses
    const store = AgentSharedStoreCodec.decode(snapshot);

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
