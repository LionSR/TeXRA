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
  figureFiles: string[];

  updateLastResponse(response: string): void;
  updateAccumulatedOutput(output: string): void;
  addFigureFiles(files: string[]): void;
}

/** Manages tool-specific runtime state and operations within a conversation round. */
export class ToolState implements IToolState {
  texcountStats: string | null;
  firstKCharsFromInput: string | null;
  lastResponse: string;
  accumulatedOutput: string;
  figureFiles: string[];

  private constructor() {
    this.texcountStats = null;
    this.firstKCharsFromInput = null;
    this.lastResponse = '';
    this.accumulatedOutput = '';
    this.figureFiles = [];
  }

  /** Creates a new ToolState instance with initialized values. */
  static initialize(): ToolState {
    return new ToolState();
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
  addFigureFiles(files: string[]): void {
    this.figureFiles.push(...files);
  }
}
