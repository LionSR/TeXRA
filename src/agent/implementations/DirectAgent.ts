// Local imports - agent components
import { BaseReflectionAgent } from './BaseReflectionAgent';

/**
 * Direct agent implementation that processes requests in a single pass.
 * Extends BaseReflectionAgent with simplified output handling and no intermediate steps.
 * Uses default XML validation behavior (validates only if useScratchpad is true).
 */
export class DirectAgent extends BaseReflectionAgent {
  protected override getTotalRounds(): number {
    return 1;
  }
}
