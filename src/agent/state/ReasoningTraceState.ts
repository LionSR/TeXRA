export interface ReasoningTraceSnapshot {
  thinkingBlocks: unknown[];
  thinkingAdded: boolean;
}

/**
 * Stores the reasoning trace returned by models that stream "thinking" content.
 * Keeping this data isolated avoids coupling it with scratchpad text or media
 * bookkeeping.
 */
export class ReasoningTraceState {
  private blocks: unknown[];
  private added: boolean;

  constructor(snapshot?: Partial<ReasoningTraceSnapshot>) {
    this.blocks = snapshot?.thinkingBlocks ? [...snapshot.thinkingBlocks] : [];
    this.added = snapshot?.thinkingAdded ?? false;
  }

  get thinkingBlocks(): unknown[] {
    return [...this.blocks];
  }

  set thinkingBlocks(blocks: unknown[]) {
    this.blocks = [...blocks];
  }

  get thinkingAdded(): boolean {
    return this.added;
  }

  set thinkingAdded(value: boolean) {
    this.added = value;
  }

  get thinkingBlock(): unknown | null {
    return this.blocks.length > 0 ? this.blocks[0] : null;
  }

  reset(): void {
    this.blocks = [];
    this.added = false;
  }

  toSnapshot(): ReasoningTraceSnapshot {
    return {
      thinkingBlocks: this.thinkingBlocks,
      thinkingAdded: this.added,
    };
  }

  static fromSnapshot(snapshot: ReasoningTraceSnapshot): ReasoningTraceState {
    return new ReasoningTraceState(snapshot);
  }
}
