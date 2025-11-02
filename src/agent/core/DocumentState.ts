/**
 * Manages document-specific metadata during agent execution.
 * Part of Pocket Flow architecture - separated from response assembly concerns.
 */

/** Interface for managing document metadata within a conversation round. */
export interface IDocumentState {
  /** Statistics about TeX document structure */
  texcountStats: string | null;

  /** Paths to figure/media files */
  mediaFiles: string[];

  addMediaFiles(files: string[]): void;
}

/**
 * Stores document-related metadata such as TeX statistics and media file paths.
 * Separated from response assembly to clarify responsibility boundaries.
 */
export class DocumentState implements IDocumentState {
  texcountStats: string | null;
  mediaFiles: string[];

  constructor() {
    this.texcountStats = null;
    this.mediaFiles = [];
  }

  /**
   * Adds new figure file paths to the collection.
   * @param files Array of paths to new figure files
   */
  addMediaFiles(files: string[]): void {
    for (const file of files) {
      if (!this.mediaFiles.includes(file)) {
        this.mediaFiles.push(file);
      }
    }
  }

  /** Converts document state to a serializable object for persistence. */
  toObject(): Record<string, any> {
    return {
      texcountStats: this.texcountStats,
      mediaFiles: [...this.mediaFiles],
    };
  }

  /** Creates a DocumentState instance from a persisted state object. */
  static fromObject(stateObj: Record<string, any> | null): DocumentState {
    if (!stateObj) {
      return new DocumentState();
    }

    const state = new DocumentState();
    state.texcountStats = stateObj.texcountStats ?? null;
    state.mediaFiles = Array.isArray(stateObj.mediaFiles)
      ? [...stateObj.mediaFiles]
      : [];
    return state;
  }
}
