// Local file imports
import { BaseReflectionAgent } from './BaseReflectionAgent';

/**
 * Chain of Thought (CoT) agent implementation that extends BaseReflectionAgent.
 * Always validates XML structure for multi-step reasoning outputs.
 */
export class CoTAgent extends BaseReflectionAgent {
  /**
   * Always validates XML structure for CoT agents.
   * Overrides default behavior to ensure proper XML formatting regardless of scratchpad mode.
   */
  protected override shouldValidateXml(): boolean {
    return true;
  }
}
