import { AgentLogger } from '@logger/AgentLogger';
import { AgentStateRound, AgentStateGlobal } from '@agent/core/AgentState';
import { FileHandler } from './FileHandler';

/**
 * Coordinates per-round completion logic.
 */
export class RoundManager {
  constructor(
    private logger: AgentLogger,
    private fileHandler: FileHandler,
  ) {}

  public async completeRound(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number,
    groupId?: string,
  ): Promise<void> {
    await this.fileHandler.finalizeRound(
      stateRound,
      stateGlobal,
      outputFile,
      endTurn,
      currRound,
      groupId,
    );
  }
}
