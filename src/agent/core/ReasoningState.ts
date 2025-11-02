/**
 * Manages reasoning/thinking block caches during agent execution.
 * Part of Pocket Flow architecture - separated from response and document concerns.
 */

/** Interface for managing reasoning caches within a conversation round. */
export interface IReasoningState {
  /** Collection of all thinking blocks from the response (used for Anthropic models) */
  thinkingBlocks: any[];

  /** Whether the thinking block has been added to the accumulated output */
  thinkingAdded: boolean;

  /** Returns the first thinking block or null if none exists */
  readonly thinkingBlock: any;

  addThinkingBlock(block: any): void;
  resetThinkingCache(): void;
}

/**
 * Stores reasoning/thinking block caches for models that support extended thinking.
 * Separated from response assembly to clarify responsibility boundaries.
 */
export class ReasoningState implements IReasoningState {
  thinkingBlocks: any[];
  thinkingAdded: boolean;

  /**
   * Returns the first thinking block from thinkingBlocks array
   * @returns The first thinking block or null if none exists
   */
  get thinkingBlock(): any {
    return this.thinkingBlocks.length > 0 ? this.thinkingBlocks[0] : null;
  }

  constructor() {
    this.thinkingBlocks = [];
    this.thinkingAdded = false;
  }

  /**
   * Adds a thinking block to the collection.
   * @param block The thinking block to add
   */
  addThinkingBlock(block: any): void {
    this.thinkingBlocks.push(block);
  }

  /**
   * Resets the thinking cache by clearing thinking blocks and reset flag.
   * Used to ensure fresh thinking blocks for subsequent responses.
   */
  resetThinkingCache(): void {
    this.thinkingBlocks = [];
    this.thinkingAdded = false;
  }

  /** Converts reasoning state to a serializable object for persistence. */
  toObject(): Record<string, any> {
    return {
      thinkingBlocks: [...this.thinkingBlocks],
      thinkingAdded: this.thinkingAdded,
    };
  }

  /** Creates a ReasoningState instance from a persisted state object. */
  static fromObject(stateObj: Record<string, any> | null): ReasoningState {
    if (!stateObj) {
      return new ReasoningState();
    }

    const state = new ReasoningState();
    state.thinkingBlocks = Array.isArray(stateObj.thinkingBlocks)
      ? [...stateObj.thinkingBlocks]
      : [];
    state.thinkingAdded = stateObj.thinkingAdded ?? false;
    return state;
  }
}
