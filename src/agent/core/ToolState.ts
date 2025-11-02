// Local imports - new focused state modules
import { ToolRuntimeStore } from '@agent/state/ToolRuntimeStore';

/** Interface for managing tool-specific runtime state within a conversation round. */
export interface IToolState {
  /** Statistics about TeX document structure */
  texcountStats: string | null;

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
  resetThinkingCache(): void;
}

/**
 * Manages tool-specific runtime state and operations within a conversation round.
 *
 * @deprecated This class is maintained for backward compatibility. New code should
 * use ToolRuntimeStore from @agent/state which provides a cleaner separation of
 * concerns aligned with Pocket Flow principles.
 *
 * Internally, this class now delegates to ToolRuntimeStore to ensure consistency
 * across the codebase.
 */
export class ToolState implements IToolState {
  /** Internal store using new focused state modules */
  private _store: ToolRuntimeStore;

  constructor() {
    this._store = new ToolRuntimeStore();
  }

  /**
   * Returns the first thinking block from thinkingBlocks array
   * @returns The first thinking block or null if none exists
   */
  get thinkingBlock(): any {
    return this._store.reasoning.thinkingBlock;
  }

  // Proxy properties to the internal store
  get texcountStats(): string | null {
    return this._store.scratchpad.texcountStats;
  }

  set texcountStats(value: string | null) {
    this._store.scratchpad.texcountStats = value;
  }

  get lastResponse(): string {
    return this._store.scratchpad.lastResponse;
  }

  set lastResponse(value: string) {
    this._store.scratchpad.lastResponse = value;
  }

  get accumulatedOutput(): string {
    return this._store.scratchpad.accumulatedOutput;
  }

  set accumulatedOutput(value: string) {
    this._store.scratchpad.accumulatedOutput = value;
  }

  get mediaFiles(): string[] {
    return this._store.media.mediaFiles;
  }

  set mediaFiles(value: string[]) {
    this._store.media.mediaFiles = value;
  }

  get thinkingBlocks(): any[] {
    return this._store.reasoning.thinkingBlocks;
  }

  set thinkingBlocks(value: any[]) {
    this._store.reasoning.thinkingBlocks = value;
  }

  get thinkingAdded(): boolean {
    return this._store.reasoning.thinkingAdded;
  }

  set thinkingAdded(value: boolean) {
    this._store.reasoning.thinkingAdded = value;
  }

  /**
   * Updates the most recent model response.
   * @param response New response text from the model
   */
  updateLastResponse(response: string): void {
    this._store.scratchpad.updateLastResponse(response);
  }

  /**
   * Updates the accumulated output with new content.
   * @param output New content to store as accumulated output
   */
  updateAccumulatedOutput(output: string): void {
    this._store.scratchpad.updateAccumulatedOutput(output);
  }

  /**
   * Adds new figure file paths to the collection.
   * @param files Array of paths to new figure files
   */
  addMediaFiles(files: string[]): void {
    this._store.media.addMediaFiles(files);
  }

  /**
   * Resets the thinking cache by clearing thinking blocks and reset flag.
   * Used to ensure fresh thinking blocks for subsequent responses.
   */
  resetThinkingCache(): void {
    this._store.reasoning.resetThinkingCache();
  }

  /**
   * Gets the internal ToolRuntimeStore for code that wants to use the new structure.
   * @internal
   */
  getStore(): ToolRuntimeStore {
    return this._store;
  }

  /**
   * Creates a ToolState from an existing ToolRuntimeStore.
   * @internal
   */
  static fromStore(store: ToolRuntimeStore): ToolState {
    const toolState = new ToolState();
    toolState._store = store;
    return toolState;
  }
}
