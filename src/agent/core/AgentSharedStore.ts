// Local imports - state slices
import { AgentRunState, ConversationRoundState } from './AgentState';
import { AgentWorkspaceState } from './AgentWorkspaceState';
import type { UserVariableChannels } from './AgentCycleOptions';

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
}

interface SharedStoreFactoryParams {
  roundIndex: number;
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
  roundState?: ConversationRoundState;
  onRoundFinalized?: AgentRoundFinalizedCallback;
}

export function createSharedStore({
  roundIndex,
  runState,
  workspaceState,
  userChannels,
  roundState,
  onRoundFinalized,
}: SharedStoreFactoryParams): AgentSharedStore {
  const initialRound = roundState ?? new ConversationRoundState(roundIndex);
  return new AgentSharedStore({
    round: initialRound,
    run: runState,
    workspace: workspaceState,
    user: userChannels,
    onRoundFinalized,
  });
}
