export interface MediaAttachmentSnapshot {
  mediaFiles: string[];
}

/**
 * Tracks media files generated during a tool run. This keeps attachment
 * bookkeeping separate from scratchpad text and reasoning traces so each
 * concern can evolve independently.
 */
export class MediaAttachmentState {
  private readonly mediaFiles = new Set<string>();

  constructor(snapshot?: MediaAttachmentSnapshot) {
    if (snapshot?.mediaFiles) {
      snapshot.mediaFiles.forEach((file) => this.mediaFiles.add(file));
    }
  }

  get all(): string[] {
    return Array.from(this.mediaFiles);
  }

  add(files: string[]): void {
    for (const file of files) {
      if (file) {
        this.mediaFiles.add(file);
      }
    }
  }

  clear(): void {
    this.mediaFiles.clear();
  }

  toSnapshot(): MediaAttachmentSnapshot {
    return { mediaFiles: this.all };
  }

  static fromSnapshot(snapshot: MediaAttachmentSnapshot): MediaAttachmentState {
    return new MediaAttachmentState(snapshot);
  }
}
