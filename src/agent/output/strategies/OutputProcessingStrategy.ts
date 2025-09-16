// Local imports - agent
import type { OutputHandler } from '../OutputHandler';

/** Strategy interface for processing agent output files. */
export interface OutputProcessingStrategy {
  /**
   * Process output files for a given round.
   * @param outputFile The output file produced by the agent.
   * @param currRound The round index being processed.
   * @param handler The handler coordinating output processing.
   */
  process(
    outputFile: string,
    currRound: number,
    handler: OutputHandler,
  ): Promise<void>;
}
