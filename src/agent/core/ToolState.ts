/** Interface for managing tool-specific runtime state within a conversation round. */
export interface IToolState {
  /** Statistics about TeX document structure */
  texcountStats: string | null;

  /** First K lines of TeX document */
  firstKCharsFromInput: string | null;

  /** Most recent model response */
  lastResponse: string;

  /** Combined output from all responses */
  accumulatedOutput: string;

  /** Paths to figure files */
  mediaFiles: string[];

  /** Collection of all thinking blocks from the response (used for Anthropic models) */
  thinkingBlocks: any[];

  /** Whether the thinking block has been added to the accumulated output */
  thinkingAdded: boolean;

  updateLastResponse(response: string): void;
  updateAccumulatedOutput(output: string): void;
  addMediaFiles(files: string[]): void;
}

/** Manages tool-specific runtime state and operations within a conversation round. */
export class ToolState implements IToolState {
  texcountStats: string | null;
  firstKCharsFromInput: string | null;
  lastResponse: string;
  accumulatedOutput: string;
  mediaFiles: string[];
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
    this.texcountStats = null;
    this.firstKCharsFromInput = null;
    this.lastResponse = '';
    this.accumulatedOutput = '';
    this.mediaFiles = [];
    this.thinkingBlocks = [];
    this.thinkingAdded = false;
  }

  /**
   * Reconstruct a ToolState instance from a plain object.
   * @param data Serialized tool state
   */
  static deserialize(data: any): ToolState {
    const state = new ToolState();
    if (!data || typeof data !== 'object') {
      return state;
    }
    state.texcountStats = data.texcountStats ?? null;
    state.firstKCharsFromInput = data.firstKCharsFromInput ?? null;
    state.lastResponse = data.lastResponse ?? '';
    state.accumulatedOutput = data.accumulatedOutput ?? '';
    state.mediaFiles = Array.isArray(data.mediaFiles) ? data.mediaFiles : [];
    state.thinkingBlocks = Array.isArray(data.thinkingBlocks)
      ? data.thinkingBlocks
      : [];
    state.thinkingAdded = data.thinkingAdded ?? false;
    return state;
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

  /**
   * Adds new figure file paths to the collection.
   * @param files Array of paths to new figure files
   */
  addMediaFiles(files: string[]): void {
    this.mediaFiles.push(...files);
  }
}
