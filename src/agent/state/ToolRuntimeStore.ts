// Local imports - tool runtime slices
import {
  ToolScratchpadState,
  type ToolScratchpadSnapshot,
} from './ToolScratchpadState';
import {
  MediaAttachmentState,
  type MediaAttachmentSnapshot,
} from './MediaAttachmentState';
import {
  ReasoningTraceState,
  type ReasoningTraceSnapshot,
} from './ReasoningTraceState';

export interface ToolRuntimeStoreSnapshot {
  scratchpad: ToolScratchpadSnapshot;
  media: MediaAttachmentSnapshot;
  reasoning: ReasoningTraceSnapshot;
}

/**
 * Composes the individual tool runtime slices into a single store that the
 * Pocket Flow nodes can share. Legacy getters/setters mirror the old ToolRuntimeStore
 * API so existing callers can migrate incrementally.
 */
export class ToolRuntimeStore {
  constructor(
    public readonly scratchpad = new ToolScratchpadState(),
    public readonly media = new MediaAttachmentState(),
    public readonly reasoning = new ReasoningTraceState(),
  ) {}

  // --- Scratchpad passthrough ---
  get texcountStats(): string | null {
    return this.scratchpad.texcountStats;
  }

  set texcountStats(value: string | null) {
    this.scratchpad.texcountStats = value;
  }

  get lastResponse(): string {
    return this.scratchpad.lastResponse;
  }

  set lastResponse(value: string) {
    this.updateLastResponse(value);
  }

  get accumulatedOutput(): string {
    return this.scratchpad.accumulatedOutput;
  }

  set accumulatedOutput(value: string) {
    this.updateAccumulatedOutput(value);
  }

  updateLastResponse(response: string): void {
    this.scratchpad.updateLastResponse(response);
  }

  updateAccumulatedOutput(output: string): void {
    this.scratchpad.updateAccumulatedOutput(output);
  }

  // --- Media passthrough ---
  get mediaFiles(): string[] {
    return this.media.all;
  }

  addMediaFiles(files: string[]): void {
    this.media.add(files);
  }

  // --- Reasoning passthrough ---
  get thinkingBlocks(): unknown[] {
    return this.reasoning.thinkingBlocks;
  }

  set thinkingBlocks(blocks: unknown[]) {
    this.reasoning.thinkingBlocks = blocks;
  }

  get thinkingAdded(): boolean {
    return this.reasoning.thinkingAdded;
  }

  set thinkingAdded(value: boolean) {
    this.reasoning.thinkingAdded = value;
  }

  get thinkingBlock(): unknown | null {
    return this.reasoning.thinkingBlock;
  }

  resetThinkingCache(): void {
    this.reasoning.reset();
  }

  toSnapshot(): ToolRuntimeStoreSnapshot {
    return {
      scratchpad: this.scratchpad.toSnapshot(),
      media: this.media.toSnapshot(),
      reasoning: this.reasoning.toSnapshot(),
    };
  }

  static fromSnapshot(snapshot: ToolRuntimeStoreSnapshot): ToolRuntimeStore {
    return new ToolRuntimeStore(
      ToolScratchpadState.fromSnapshot(snapshot.scratchpad),
      MediaAttachmentState.fromSnapshot(snapshot.media),
      ReasoningTraceState.fromSnapshot(snapshot.reasoning),
    );
  }
}
