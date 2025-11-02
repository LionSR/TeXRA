/**
 * State for managing media file attachments.
 *
 * This focused state module handles media file paths separately from text scratchpad
 * and reasoning traces, maintaining clear boundaries between different runtime concerns.
 */
export interface IMediaAttachmentState {
  /** Paths to figure files */
  mediaFiles: string[];

  addMediaFiles(files: string[]): void;
}

/**
 * Manages media file attachments for tool runtime.
 *
 * Focuses exclusively on media file tracking to maintain clear separation
 * of concerns from text and reasoning state.
 */
export class MediaAttachmentState implements IMediaAttachmentState {
  mediaFiles: string[];

  constructor() {
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

  /** Converts state to a serializable object for persistence. */
  toObject(): Record<string, any> {
    return {
      mediaFiles: [...this.mediaFiles],
    };
  }

  /** Creates a MediaAttachmentState instance from a persisted state object. */
  static fromObject(
    stateObj: Record<string, any> | null,
  ): MediaAttachmentState {
    if (!stateObj) {
      return new MediaAttachmentState();
    }

    const state = new MediaAttachmentState();
    state.mediaFiles = Array.isArray(stateObj.mediaFiles)
      ? [...stateObj.mediaFiles]
      : [];
    return state;
  }
}
