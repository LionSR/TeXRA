import { BaseReflectionAgent } from './BaseReflectionAgent';

/**
 * Direct agent implementation that processes requests in a single pass.
 * Extends BaseReflectionAgent with simplified output handling and no intermediate steps.
 */
export class DirectAgent extends BaseReflectionAgent {
  protected override getTotalRounds(): number {
    return 1;
  }

  /**
   * Only ensure XML structure when scratchpad mode is enabled.
   */
  protected override shouldEnsureXmlStructure(): boolean {
    return this.useScratchpad;
  }
}
