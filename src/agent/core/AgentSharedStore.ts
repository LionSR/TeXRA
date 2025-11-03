// Local imports - state slices
import { AgentRunState, ConversationRoundState } from './AgentState';
import { ToolRuntimeState } from './ToolRuntimeState';
import type { AgentUserVarChannels } from './AgentCycleOptions';

export interface AgentSharedStoreSlices {
  round: ConversationRoundState;
  run: AgentRunState;
  tool: ToolRuntimeState;
  user: AgentUserVarChannels;
}

export class AgentSharedStore {
  private roundState: ConversationRoundState;
  private readonly runState: AgentRunState;
  private readonly toolState: ToolRuntimeState;
  private readonly userChannels: AgentUserVarChannels;

  constructor(slices: AgentSharedStoreSlices) {
    this.roundState = slices.round;
    this.runState = slices.run;
    this.toolState = slices.tool;
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

  get tool(): ToolRuntimeState {
    return this.toolState;
  }

  get user(): AgentUserVarChannels {
    return this.userChannels;
  }

  finalizeRound(): void {
    this.runState.recordRound(this.roundState);
  }
}
