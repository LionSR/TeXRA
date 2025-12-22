/**
 * Unified round context - single source of truth for per-round data.
 *
 * Replaces the parallel arrays pattern (outputFile[], roundStates[], etc.).
 * Each round has exactly one RoundContext containing all related data.
 */

import { ConversationRoundState } from './AgentState';
import { AgentWorkspaceState } from './AgentWorkspaceState';
import type { RoundOutput, AgentFileLocation } from '@agent/output/types';

/**
 * Context for a single conversation round.
 */
export class RoundContext {
  readonly index: number;
  readonly outputLocation: AgentFileLocation;
  additionalOutputs: AgentFileLocation[];
  roundState: ConversationRoundState | null;
  workspaceState: AgentWorkspaceState | null;
  output: RoundOutput | null;

  constructor(params: {
    index: number;
    outputLocation: AgentFileLocation;
    additionalOutputs?: AgentFileLocation[];
    roundState?: ConversationRoundState | null;
    workspaceState?: AgentWorkspaceState | null;
    output?: RoundOutput | null;
  }) {
    this.index = params.index;
    this.outputLocation = params.outputLocation;
    this.additionalOutputs = params.additionalOutputs ?? [];
    this.roundState = params.roundState ?? null;
    this.workspaceState = params.workspaceState ?? null;
    this.output = params.output ?? null;
  }

  setExecutionState(
    roundState: ConversationRoundState,
    workspaceState: AgentWorkspaceState,
  ): void {
    this.roundState = roundState;
    this.workspaceState = workspaceState;
  }

  setOutput(output: RoundOutput): void {
    this.output = output;
  }
}

/**
 * Manages a collection of round contexts with indexed access.
 */
export class RoundContextCollection {
  private readonly rounds: RoundContext[] = [];

  get(index: number): RoundContext | undefined {
    return this.rounds[index];
  }

  getRequired(index: number): RoundContext {
    const context = this.rounds[index];
    if (!context) {
      throw new Error(`Round ${index} does not exist`);
    }
    return context;
  }

  create(params: {
    outputLocation: AgentFileLocation;
    additionalOutputs?: AgentFileLocation[];
  }): RoundContext {
    const context = new RoundContext({
      index: this.rounds.length,
      outputLocation: params.outputLocation,
      additionalOutputs: params.additionalOutputs,
    });
    this.rounds.push(context);
    return context;
  }

  all(): readonly RoundContext[] {
    return this.rounds;
  }

  clearOutputs(): void {
    for (const round of this.rounds) {
      round.output = null;
      round.roundState = null;
      round.workspaceState = null;
    }
  }

  updateOutputLocation(index: number, location: AgentFileLocation): void {
    const round = this.rounds[index];
    if (!round) {
      throw new Error(`Round ${index} does not exist`);
    }
    this.rounds[index] = new RoundContext({
      index: round.index,
      outputLocation: location,
      additionalOutputs: round.additionalOutputs,
      roundState: round.roundState,
      workspaceState: round.workspaceState,
      output: round.output,
    });
  }
}
