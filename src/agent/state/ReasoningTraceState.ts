/**
 * State for managing model reasoning traces (thinking blocks).
 *
 * This focused state module handles Anthropic "thinking" caches and related metadata,
 * separating these concerns from scratchpad text and media attachments.
 */
export interface IReasoningTraceState {
  /** Collection of all thinking blocks from the response (used for Anthropic models) */
  thinkingBlocks: any[];

  /** Whether the thinking block has been added to the accumulated output */
  thinkingAdded: boolean;

  resetThinkingCache(): void;
}

/**
 * Manages reasoning trace state including thinking blocks.
 *
 * Focuses exclusively on reasoning-related state to maintain clear boundaries
 * between different runtime concerns.
 */
export class ReasoningTraceState implements IReasoningTraceState {
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
   * Resets the thinking cache by clearing thinking blocks and reset flag.
   * Used to ensure fresh thinking blocks for subsequent responses.
   */
  resetThinkingCache(): void {
    this.thinkingBlocks = [];
    this.thinkingAdded = false;
  }

  /** Converts state to a serializable object for persistence. */
  toObject(): Record<string, any> {
    return {
      thinkingBlocks: [...this.thinkingBlocks],
      thinkingAdded: this.thinkingAdded,
    };
  }

  /** Creates a ReasoningTraceState instance from a persisted state object. */
  static fromObject(stateObj: Record<string, any> | null): ReasoningTraceState {
    if (!stateObj) {
      return new ReasoningTraceState();
    }

    const state = new ReasoningTraceState();
    state.thinkingBlocks = Array.isArray(stateObj.thinkingBlocks)
      ? [...stateObj.thinkingBlocks]
      : [];
    state.thinkingAdded = stateObj.thinkingAdded ?? false;
    return state;
  }
}
