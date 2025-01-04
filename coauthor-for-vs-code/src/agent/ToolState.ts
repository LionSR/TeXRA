/**
 * Interface defining the shape of tool-specific runtime data that doesn't need to be logged
 */
export interface IToolState {
  /** Statistics about TeX document structure */
  texCountStats: string | null;

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

/**
 * Implementation of tool-specific runtime data that doesn't need to be logged. [Per round]
 */
export class ToolState implements IToolState {
  texCountStats: string | null;
  firstKCharsFromInput: string | null;
  lastResponse: string;
  accumulatedOutput: string;
  figureFiles: string[];

  private constructor() {
    this.texCountStats = null;
    this.firstKCharsFromInput = null;
    this.lastResponse = '';
    this.accumulatedOutput = '';
    this.figureFiles = [];
  }

  /**
   * Initialize a new ToolState object
   */
  static initialize(): ToolState {
    return new ToolState();
  }

  /**
   * Update the last response
   */
  updateLastResponse(response: string): void {
    this.lastResponse = response;
  }

  /**
   * Update the accumulated output
   */
  updateAccumulatedOutput(output: string): void {
    this.accumulatedOutput = output;
  }

  /**
   * Add figure files to the list
   */
  addFigureFiles(files: string[]): void {
    this.figureFiles.push(...files);
  }
}
