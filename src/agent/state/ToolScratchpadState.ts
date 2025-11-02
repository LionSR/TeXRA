/**
 * State for managing tool scratchpad and text accumulation.
 *
 * This focused state module handles text-based runtime data including TeX statistics,
 * response fragments, and accumulated output, separating these concerns from media
 * attachments and reasoning traces.
 */
export interface IToolScratchpadState {
  /** Statistics about TeX document structure */
  texcountStats: string | null;

  /** Most recent model response */
  lastResponse: string;

  /** Combined output from all responses */
  accumulatedOutput: string;

  updateLastResponse(response: string): void;
  updateAccumulatedOutput(output: string): void;
}

/**
 * Manages scratchpad text and accumulated output for tool runtime.
 *
 * Focuses exclusively on text-based state to maintain clear boundaries
 * between different runtime concerns.
 */
export class ToolScratchpadState implements IToolScratchpadState {
  texcountStats: string | null;
  lastResponse: string;
  accumulatedOutput: string;

  constructor() {
    this.texcountStats = null;
    this.lastResponse = '';
    this.accumulatedOutput = '';
  }

  /**
   * Updates the most recent model response.
   * @param response New response text from the model
   */
  updateLastResponse(response: string): void {
    this.lastResponse = response;
  }

  /**
   * Updates the accumulated output with new content.
   * @param output New content to store as accumulated output
   */
  updateAccumulatedOutput(output: string): void {
    this.accumulatedOutput = output;
  }

  /** Converts state to a serializable object for persistence. */
  toObject(): Record<string, any> {
    return {
      texcountStats: this.texcountStats,
      lastResponse: this.lastResponse,
      accumulatedOutput: this.accumulatedOutput,
    };
  }

  /** Creates a ToolScratchpadState instance from a persisted state object. */
  static fromObject(stateObj: Record<string, any> | null): ToolScratchpadState {
    if (!stateObj) {
      return new ToolScratchpadState();
    }

    const state = new ToolScratchpadState();
    state.texcountStats = stateObj.texcountStats ?? null;
    state.lastResponse = stateObj.lastResponse ?? '';
    state.accumulatedOutput = stateObj.accumulatedOutput ?? '';
    return state;
  }
}
