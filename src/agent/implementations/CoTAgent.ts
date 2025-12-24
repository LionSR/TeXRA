import { BaseReflectionAgent } from './BaseReflectionAgent';

/**
 * Chain of Thought (CoT) agent implementation that extends BaseReflectionAgent.
 * Adds XML structure validation and specialized output handling for multi-step reasoning.
 */
export class CoTAgent extends BaseReflectionAgent {
  /**
   * Always ensure XML structure for CoT agents (multi-step reasoning uses XML).
   */
  protected override shouldEnsureXmlStructure(): boolean {
    return true;
  }
}
