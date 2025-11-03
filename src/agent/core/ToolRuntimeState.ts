export class ResponseAssemblyState {
  public lastResponse = '';
  public accumulatedOutput = '';

  updateLastResponse(response: string): void {
    this.lastResponse = response;
  }

  updateAccumulatedOutput(output: string): void {
    this.accumulatedOutput = output;
  }
}

export class MediaAttachmentState {
  public readonly files: string[] = [];

  addMediaFiles(paths: string[]): void {
    for (const path of paths) {
      if (!this.files.includes(path)) {
        this.files.push(path);
      }
    }
  }
}

export class ReasoningCacheState {
  public thinkingBlocks: any[] = [];
  public thinkingAdded = false;

  get primaryBlock(): any | null {
    return this.thinkingBlocks.length > 0 ? this.thinkingBlocks[0] : null;
  }

  reset(): void {
    this.thinkingBlocks = [];
    this.thinkingAdded = false;
  }
}

export class DocumentStatsState {
  public texcountStats: string | null = null;

  updateTeXCountStats(stats: string | null): void {
    this.texcountStats = stats;
  }
}

export interface ToolRuntimeSnapshot {
  assembly: {
    lastResponse: string;
    accumulatedOutput: string;
  };
  media: {
    files: string[];
  };
  reasoning: {
    thinkingBlocks: any[];
    thinkingAdded: boolean;
  };
  document: {
    texcountStats: string | null;
  };
}

export class ToolRuntimeState {
  public readonly assembly = new ResponseAssemblyState();
  public readonly media = new MediaAttachmentState();
  public readonly reasoning = new ReasoningCacheState();
  public readonly document = new DocumentStatsState();

  resetReasoning(): void {
    this.reasoning.reset();
  }

  toJSON(): ToolRuntimeSnapshot {
    return {
      assembly: {
        lastResponse: this.assembly.lastResponse,
        accumulatedOutput: this.assembly.accumulatedOutput,
      },
      media: {
        files: [...this.media.files],
      },
      reasoning: {
        thinkingBlocks: [...this.reasoning.thinkingBlocks],
        thinkingAdded: this.reasoning.thinkingAdded,
      },
      document: {
        texcountStats: this.document.texcountStats,
      },
    };
  }

  static fromJSON(snapshot: ToolRuntimeSnapshot | null): ToolRuntimeState {
    const state = new ToolRuntimeState();
    if (!snapshot) {
      return state;
    }

    state.assembly.lastResponse = snapshot.assembly.lastResponse;
    state.assembly.accumulatedOutput = snapshot.assembly.accumulatedOutput;
    state.media.files.push(...snapshot.media.files);
    state.reasoning.thinkingBlocks.push(...snapshot.reasoning.thinkingBlocks);
    state.reasoning.thinkingAdded = snapshot.reasoning.thinkingAdded;
    state.document.texcountStats = snapshot.document.texcountStats;
    return state;
  }
}
