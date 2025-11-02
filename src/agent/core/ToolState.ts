// Local imports - state holders
import { DocumentState, type IDocumentState } from './DocumentState';
import { ResponseState, type IResponseState } from './ResponseState';
import { ReasoningState, type IReasoningState } from './ReasoningState';

/**
 * Unified interface for tool-specific runtime state within a conversation round.
 * Part of Pocket Flow architecture - composes separate state concerns.
 */
export interface IToolState {
  /** Document metadata holder */
  document: IDocumentState;

  /** Response assembly holder */
  response: IResponseState;

  /** Reasoning/thinking cache holder */
  reasoning: IReasoningState;

  // Legacy accessors for backward compatibility (with setters for direct assignment)
  texcountStats: string | null;
  lastResponse: string;
  accumulatedOutput: string;
  readonly mediaFiles: string[];
  thinkingBlocks: any[];
  thinkingAdded: boolean;
  readonly thinkingBlock: any;

  updateLastResponse(response: string): void;
  updateAccumulatedOutput(output: string): void;
  addMediaFiles(files: string[]): void;
  resetThinkingCache(): void;
}

/**
 * Manages tool-specific runtime state through composition of focused state holders.
 * Part of Pocket Flow architecture - clearly separates document, response, and reasoning concerns.
 */
export class ToolState implements IToolState {
  /** Document metadata holder */
  public document: DocumentState;

  /** Response assembly holder */
  public response: ResponseState;

  /** Reasoning/thinking cache holder */
  public reasoning: ReasoningState;

  constructor() {
    this.document = new DocumentState();
    this.response = new ResponseState();
    this.reasoning = new ReasoningState();
  }

  // Legacy accessors for backward compatibility
  get texcountStats(): string | null {
    return this.document.texcountStats;
  }
  set texcountStats(value: string | null) {
    this.document.texcountStats = value;
  }

  get lastResponse(): string {
    return this.response.lastResponse;
  }
  set lastResponse(value: string) {
    this.response.lastResponse = value;
  }

  get accumulatedOutput(): string {
    return this.response.accumulatedOutput;
  }
  set accumulatedOutput(value: string) {
    this.response.accumulatedOutput = value;
  }

  get mediaFiles(): string[] {
    return this.document.mediaFiles;
  }

  get thinkingBlocks(): any[] {
    return this.reasoning.thinkingBlocks;
  }
  set thinkingBlocks(value: any[]) {
    this.reasoning.thinkingBlocks = value;
  }

  get thinkingAdded(): boolean {
    return this.reasoning.thinkingAdded;
  }
  set thinkingAdded(value: boolean) {
    this.reasoning.thinkingAdded = value;
  }

  get thinkingBlock(): any {
    return this.reasoning.thinkingBlock;
  }

  /**
   * Updates the most recent model response.
   * @param response New response text from the model
   */
  updateLastResponse(response: string): void {
    this.response.updateLastResponse(response);
  }

  /**
   * Updates the accumulated output with new content.
   * @param output New content to store as accumulated output
   */
  updateAccumulatedOutput(output: string): void {
    this.response.updateAccumulatedOutput(output);
  }

  /**
   * Adds new figure file paths to the collection.
   * @param files Array of paths to new figure files
   */
  addMediaFiles(files: string[]): void {
    this.document.addMediaFiles(files);
  }

  /**
   * Resets the thinking cache by clearing thinking blocks and reset flag.
   * Used to ensure fresh thinking blocks for subsequent responses.
   */
  resetThinkingCache(): void {
    this.reasoning.resetThinkingCache();
  }

  /** Converts tool state to a serializable object for persistence. */
  toObject(): Record<string, any> {
    return {
      document: this.document.toObject(),
      response: this.response.toObject(),
      reasoning: this.reasoning.toObject(),
    };
  }

  /** Creates a ToolState instance from a persisted state object. */
  static fromObject(stateObj: Record<string, any> | null): ToolState {
    if (!stateObj) {
      return new ToolState();
    }

    const state = new ToolState();
    state.document = DocumentState.fromObject(stateObj.document ?? null);
    state.response = ResponseState.fromObject(stateObj.response ?? null);
    state.reasoning = ReasoningState.fromObject(stateObj.reasoning ?? null);
    return state;
  }
}
