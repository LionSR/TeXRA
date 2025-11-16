// Third-party imports
import { z } from 'zod';

/**
 * Thinking block from reasoning models.
 * This represents the internal reasoning/thinking output from models like Claude Sonnet 4.
 * Uses a flexible structure to accommodate different provider formats.
 */
export interface ThinkingBlock {
  type: string;
  thinking?: unknown;
  [key: string]: unknown;
}

/**
 * Workspace assembly state keeps track of the model's textual output so the
 * agent can resume mid-conversation without rebuilding strings from scratch.
 */
export class ResponseAssemblyState {
  private _lastResponse = '';
  private _accumulatedOutput = '';

  get lastResponse(): string {
    return this._lastResponse;
  }

  set lastResponse(value: string) {
    this._lastResponse = value;
  }

  get accumulatedOutput(): string {
    return this._accumulatedOutput;
  }

  set accumulatedOutput(value: string) {
    this._accumulatedOutput = value;
  }

  updateLastResponse(response: string): void {
    this._lastResponse = response;
  }

  updateAccumulatedOutput(output: string): void {
    this._accumulatedOutput = output;
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
  public thinkingBlocks: ThinkingBlock[] = [];
  public thinkingAdded = false;

  get primaryBlock(): ThinkingBlock | null {
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

export const ThinkingBlockSchema = z
  .object({
    type: z.string(),
    thinking: z.unknown().optional(),
  })
  .passthrough();

export const AgentWorkspaceStateSnapshotSchema = z.strictObject({
  assembly: z.strictObject({
    lastResponse: z.string(),
    accumulatedOutput: z.string(),
  }),
  media: z.strictObject({ files: z.array(z.string()) }),
  reasoning: z.strictObject({
    thinkingBlocks: z.array(ThinkingBlockSchema),
    thinkingAdded: z.boolean(),
  }),
  document: z.strictObject({ texcountStats: z.string().nullable() }),
});

export type AgentWorkspaceSnapshot = z.infer<
  typeof AgentWorkspaceStateSnapshotSchema
>;

export class AgentWorkspaceState {
  public readonly assembly = new ResponseAssemblyState();
  public readonly media = new MediaAttachmentState();
  public readonly reasoning = new ReasoningCacheState();
  public readonly document = new DocumentStatsState();

  resetReasoning(): void {
    this.reasoning.reset();
  }

  toJSON(): AgentWorkspaceSnapshot {
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

  static fromJSON(
    snapshot: AgentWorkspaceSnapshot | null,
  ): AgentWorkspaceState {
    const state = new AgentWorkspaceState();
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
