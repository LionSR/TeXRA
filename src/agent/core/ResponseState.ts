/**
 * Manages response assembly during agent execution.
 * Part of Pocket Flow architecture - separated from document metadata concerns.
 */

/** Interface for managing response assembly within a conversation round. */
export interface IResponseState {
  /** Most recent model response */
  lastResponse: string;

  /** Combined output from all responses */
  accumulatedOutput: string;

  updateLastResponse(response: string): void;
  updateAccumulatedOutput(output: string): void;
  appendToAccumulated(connector: string, response: string): void;
}

/**
 * Stores response assembly state including last response and accumulated output.
 * Separated from document metadata to clarify responsibility boundaries.
 */
export class ResponseState implements IResponseState {
  lastResponse: string;
  accumulatedOutput: string;

  constructor() {
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
   * Replaces the accumulated output with new content.
   * @param output New content to store as accumulated output
   */
  updateAccumulatedOutput(output: string): void {
    this.accumulatedOutput = output;
  }

  /**
   * Appends new content to accumulated output with a connector.
   * @param connector Connection string between existing and new content
   * @param response New response to append
   */
  appendToAccumulated(connector: string, response: string): void {
    this.accumulatedOutput += connector + response;
  }

  /** Converts response state to a serializable object for persistence. */
  toObject(): Record<string, any> {
    return {
      lastResponse: this.lastResponse,
      accumulatedOutput: this.accumulatedOutput,
    };
  }

  /** Creates a ResponseState instance from a persisted state object. */
  static fromObject(stateObj: Record<string, any> | null): ResponseState {
    if (!stateObj) {
      return new ResponseState();
    }

    const state = new ResponseState();
    state.lastResponse = stateObj.lastResponse ?? '';
    state.accumulatedOutput = stateObj.accumulatedOutput ?? '';
    return state;
  }
}
