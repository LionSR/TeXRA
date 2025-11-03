// Local imports - state slices
import { AgentRunState, ConversationRoundState } from './AgentState';
import { AgentWorkspaceState } from './AgentWorkspaceState';
import type { UserVariableChannels } from './AgentCycleOptions';

export interface AgentSharedStoreSlices {
  round: ConversationRoundState;
  run: AgentRunState;
  workspace: AgentWorkspaceState;
  user: UserVariableChannels;
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

  constructor(slices: AgentSharedStoreSlices) {
    this.roundState = slices.round;
    this.runState = slices.run;
    this.workspaceState = slices.workspace;
    this.userChannels = slices.user;
  }

  get round(): ConversationRoundState {
    return this.roundState;
  }

  setRound(roundState: ConversationRoundState): void {
    this.roundState = roundState;
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

  finalizeRound(): void {
    this.runState.recordRound(this.roundState);
  }
}
