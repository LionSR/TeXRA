/** Snapshot shape for document-related tool state. */
export interface DocumentAssetSnapshot {
  texcountStats: string | null;
  mediaFiles: string[];
}

/** Manages extracted media and TeX statistics. */
export class DocumentAssetState {
  texcountStats: string | null;
  mediaFiles: string[];

  constructor() {
    this.texcountStats = null;
    this.mediaFiles = [];
  }

  setTeXCount(stats: string | null): void {
    this.texcountStats = stats;
  }

  addMediaFiles(files: string[]): void {
    for (const file of files) {
      if (!this.mediaFiles.includes(file)) {
        this.mediaFiles.push(file);
      }
    }
  }

  toSnapshot(): DocumentAssetSnapshot {
    return {
      texcountStats: this.texcountStats,
      mediaFiles: [...this.mediaFiles],
    };
  }

  static fromSnapshot(snapshot: DocumentAssetSnapshot | null): DocumentAssetState {
    const state = new DocumentAssetState();
    if (!snapshot) {
      return state;
    }

    state.texcountStats = snapshot.texcountStats ?? null;
    state.mediaFiles = [...(snapshot.mediaFiles ?? [])];
    return state;
  }
}

/** Snapshot shape for response drafting state. */
export interface ResponseDraftSnapshot {
  lastResponse: string;
  accumulatedOutput: string;
}

/** Tracks incremental response drafting data. */
export class ResponseDraftState {
  lastResponse: string;
  accumulatedOutput: string;

  constructor() {
    this.lastResponse = '';
    this.accumulatedOutput = '';
  }

  setLastResponse(response: string): void {
    this.lastResponse = response;
  }

  setAccumulatedOutput(output: string): void {
    this.accumulatedOutput = output;
  }

  toSnapshot(): ResponseDraftSnapshot {
    return {
      lastResponse: this.lastResponse,
      accumulatedOutput: this.accumulatedOutput,
    };
  }

  static fromSnapshot(snapshot: ResponseDraftSnapshot | null): ResponseDraftState {
    const state = new ResponseDraftState();
    if (!snapshot) {
      return state;
    }

    state.lastResponse = snapshot.lastResponse ?? '';
    state.accumulatedOutput = snapshot.accumulatedOutput ?? '';
    return state;
  }
}

/** Snapshot shape for reasoning trace state. */
export interface ReasoningTraceSnapshot {
  thinkingBlocks: unknown[];
  thinkingAdded: boolean;
}

/** Stores free-form thinking traces emitted by models. */
export class ReasoningTraceState {
  thinkingBlocks: unknown[];
  thinkingAdded: boolean;

  constructor() {
    this.thinkingBlocks = [];
    this.thinkingAdded = false;
  }

  get primaryBlock(): unknown | null {
    return this.thinkingBlocks.length > 0 ? this.thinkingBlocks[0] : null;
  }

  reset(): void {
    this.thinkingBlocks = [];
    this.thinkingAdded = false;
  }

  toSnapshot(): ReasoningTraceSnapshot {
    return {
      thinkingBlocks: [...this.thinkingBlocks],
      thinkingAdded: this.thinkingAdded,
    };
  }

  static fromSnapshot(snapshot: ReasoningTraceSnapshot | null): ReasoningTraceState {
    const state = new ReasoningTraceState();
    if (!snapshot) {
      return state;
    }

    state.thinkingBlocks = [...(snapshot.thinkingBlocks ?? [])];
    state.thinkingAdded = snapshot.thinkingAdded ?? false;
    return state;
  }
}

/** Composite tool response state exposing slice-based accessors. */
export class ToolResponseState {
  document: DocumentAssetState;
  draft: ResponseDraftState;
  reasoning: ReasoningTraceState;

  constructor(
    document: DocumentAssetState = new DocumentAssetState(),
    draft: ResponseDraftState = new ResponseDraftState(),
    reasoning: ReasoningTraceState = new ReasoningTraceState(),
  ) {
    this.document = document;
    this.draft = draft;
    this.reasoning = reasoning;
  }

  get texcountStats(): string | null {
    return this.document.texcountStats;
  }

  set texcountStats(value: string | null) {
    this.document.setTeXCount(value);
  }

  get mediaFiles(): string[] {
    return this.document.mediaFiles;
  }

  addMediaFiles(files: string[]): void {
    this.document.addMediaFiles(files);
  }

  get lastResponse(): string {
    return this.draft.lastResponse;
  }

  set lastResponse(value: string) {
    this.draft.setLastResponse(value);
  }

  updateLastResponse(value: string): void {
    this.draft.setLastResponse(value);
  }

  get accumulatedOutput(): string {
    return this.draft.accumulatedOutput;
  }

  set accumulatedOutput(value: string) {
    this.draft.setAccumulatedOutput(value);
  }

  updateAccumulatedOutput(value: string): void {
    this.draft.setAccumulatedOutput(value);
  }

  get thinkingBlocks(): unknown[] {
    return this.reasoning.thinkingBlocks;
  }

  set thinkingBlocks(blocks: unknown[]) {
    this.reasoning.thinkingBlocks = [...blocks];
  }

  get thinkingBlock(): unknown | null {
    return this.reasoning.primaryBlock;
  }

  get thinkingAdded(): boolean {
    return this.reasoning.thinkingAdded;
  }

  set thinkingAdded(value: boolean) {
    this.reasoning.thinkingAdded = value;
  }

  resetThinkingCache(): void {
    this.reasoning.reset();
  }

  toSnapshot(): ToolResponseSnapshot {
    return {
      document: this.document.toSnapshot(),
      draft: this.draft.toSnapshot(),
      reasoning: this.reasoning.toSnapshot(),
    };
  }

  static fromSnapshot(snapshot: ToolResponseSnapshot | null): ToolResponseState {
    return new ToolResponseState(
      DocumentAssetState.fromSnapshot(snapshot?.document ?? null),
      ResponseDraftState.fromSnapshot(snapshot?.draft ?? null),
      ReasoningTraceState.fromSnapshot(snapshot?.reasoning ?? null),
    );
  }
}

export interface ToolResponseSnapshot {
  document: DocumentAssetSnapshot;
  draft: ResponseDraftSnapshot;
  reasoning: ReasoningTraceSnapshot;
}

export function createToolResponseState(): ToolResponseState {
  return new ToolResponseState();
}

export function toolResponseStateFromSnapshot(
  snapshot: ToolResponseSnapshot | null,
): ToolResponseState {
  return ToolResponseState.fromSnapshot(snapshot);
}

export function toolResponseStateToSnapshot(
  state: ToolResponseState,
): ToolResponseSnapshot {
  return state.toSnapshot();
}
