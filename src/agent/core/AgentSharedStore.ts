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
  type AgentWorkspaceSnapshot,
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

export const AgentSharedStoreSnapshotSchema = z.strictObject({
  round: ConversationRoundStateSnapshotSchema,
  run: AgentRunStateSnapshotSchema,
  workspace: AgentWorkspaceStateSnapshotSchema,
  user: UserVariableChannelsSchema,
});

export type AgentSharedStoreSnapshot = z.infer<
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
  private readonly onRoundFinalized?: AgentRoundFinalizedCallback;

  constructor(config: AgentSharedStoreOptions) {
    this.roundState = config.round;
    this.runState = config.run;
    this.workspaceState = config.workspace;
    this.userChannels = config.user;
    this.onRoundFinalized = config.onRoundFinalized;
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

  async finalizeRound(): Promise<void> {
    this.runState.recordRound(this.roundState);
    if (this.onRoundFinalized) {
      await this.onRoundFinalized({
        round: this.roundState,
        run: this.runState,
        workspace: this.workspaceState,
      });
    }
  }

  toJSON(): AgentSharedStoreSnapshot {
    return {
      round: this.roundState.toJSON(),
      run: this.runState.toJSON(),
      workspace: this.workspaceState.toJSON(),
      user: {
        input: { ...this.userChannels.input },
        transient: { ...this.userChannels.transient },
        output: { ...this.userChannels.output },
      },
    };
  }

  static fromJSON(
    snapshot: AgentSharedStoreSnapshot,
    options?: { onRoundFinalized?: AgentRoundFinalizedCallback },
  ): AgentSharedStore {
    const round = ConversationRoundState.fromJSON(snapshot.round);
    const run = AgentRunState.fromJSON(snapshot.run);
    const workspace = AgentWorkspaceState.fromJSON(snapshot.workspace);
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
      onRoundFinalized: options?.onRoundFinalized,
    });
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
    AgentSharedStoreSnapshotSchema.parse(snapshot);
    return AgentSharedStore.fromJSON(snapshot, {
      onRoundFinalized: args.onRoundFinalized,
    });
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
