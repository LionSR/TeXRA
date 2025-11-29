// Third-party imports
import { z } from 'zod';

/**
 * Thinking block from reasoning models.
 * This represents the internal reasoning/thinking output from models like Claude Sonnet 4.
 * Supports both regular thinking blocks and redacted thinking blocks from Anthropic.
 */
export interface ThinkingBlock {
  /** Block type: 'thinking' for regular, 'redacted_thinking' for redacted */
  type: string;
  /** Thinking content (for regular thinking blocks) */
  thinking?: string;
  /** Signature for verification (for regular thinking blocks from Anthropic) */
  signature?: string;
  /** Encrypted data (for redacted thinking blocks from Anthropic) */
  data?: string;
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

export class FileInteractionState {
  private readonly readFiles = new Set<string>();
  private readonly edits = new Map<
    string,
    { added: number; removed: number }
  >();

  recordRead(path: string | undefined | null): void {
    if (!path) return;
    this.readFiles.add(path);
  }

  hasRead(path: string | undefined | null): boolean {
    if (!path) return false;
    return this.readFiles.has(path);
  }

  /**
   * Records per-path edit deltas and returns a deduped list of files edited
   * during this call alongside the aggregate line change totals for the call.
   */
  recordEdits(
    edits:
      | { path?: string; lineChanges?: { added?: number; removed?: number } }[]
      | undefined,
  ): {
    edits: { path: string; lineChanges?: { added: number; removed: number } }[];
    lineChanges?: { added: number; removed: number };
  } {
    if (!Array.isArray(edits)) {
      return { edits: [] };
    }

    const perCallEdits = new Map<string, { added: number; removed: number }>();
    let added = 0;
    let removed = 0;

    for (const entry of edits) {
      const path = entry?.path;
      if (!path) continue;

      const existing = this.edits.get(path) ?? { added: 0, removed: 0 };
      const deltaAdded = entry.lineChanges?.added ?? 0;
      const deltaRemoved = entry.lineChanges?.removed ?? 0;

      existing.added += deltaAdded;
      existing.removed += deltaRemoved;
      this.edits.set(path, existing);

      const current = perCallEdits.get(path) ?? { added: 0, removed: 0 };
      current.added += deltaAdded;
      current.removed += deltaRemoved;
      perCallEdits.set(path, current);

      added += deltaAdded;
      removed += deltaRemoved;
    }

    const editsForCall = Array.from(perCallEdits.entries()).map(
      ([path, diff]) => ({
        path,
        lineChanges:
          diff.added || diff.removed
            ? { added: diff.added, removed: diff.removed }
            : undefined,
      }),
    );

    const lineChanges = added || removed ? { added, removed } : undefined;
    return { edits: editsForCall, lineChanges };
  }

  toJSON(): {
    readFiles: string[];
    edits: { path: string; added: number; removed: number }[];
  } {
    return {
      readFiles: Array.from(this.readFiles),
      edits: Array.from(this.edits.entries()).map(([path, diff]) => ({
        path,
        added: diff.added,
        removed: diff.removed,
      })),
    };
  }

  static fromJSON(data: {
    readFiles?: string[];
    edits?: { path?: string; added?: number; removed?: number }[];
  }): FileInteractionState {
    const state = new FileInteractionState();
    // Restore read files
    (data.readFiles ?? []).forEach((path) => state.recordRead(path));
    // Restore edits directly (absolute values, not deltas)
    (data.edits ?? []).forEach((entry) => {
      if (!entry?.path) return;
      state.edits.set(entry.path, {
        added: entry.added ?? 0,
        removed: entry.removed ?? 0,
      });
    });
    return state;
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

export const ThinkingBlockSchema = z.object({
  type: z.string(),
  thinking: z.string().optional(),
  signature: z.string().optional(),
  data: z.string().optional(),
});

/**
 * We use z.object() instead of z.strictObject() to remain backward compatible
 * with legacy workspace snapshots that may contain removed or renamed fields.
 */
export const AgentWorkspaceStateSnapshotSchema = z.object({
  assembly: z.object({
    lastResponse: z.string(),
    accumulatedOutput: z.string(),
  }),
  media: z.object({ files: z.array(z.string()) }),
  reasoning: z.object({
    thinkingBlocks: z.array(ThinkingBlockSchema),
    thinkingAdded: z.boolean(),
  }),
  document: z.object({ texcountStats: z.string().nullable() }),
  interactions: z
    .object({
      readFiles: z.array(z.string()),
      edits: z.array(
        z.object({
          path: z.string(),
          added: z.number().optional(),
          removed: z.number().optional(),
        }),
      ),
    })
    .optional()
    .default({
      readFiles: [],
      edits: [],
    }),
});

export type AgentWorkspaceSnapshot = z.infer<
  typeof AgentWorkspaceStateSnapshotSchema
>;

export class AgentWorkspaceState {
  public readonly assembly = new ResponseAssemblyState();
  public readonly media = new MediaAttachmentState();
  public readonly reasoning = new ReasoningCacheState();
  public readonly document = new DocumentStatsState();
  public readonly interactions = new FileInteractionState();

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
      interactions: this.interactions.toJSON(),
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
    // Restore file interactions directly using fromJSON (single source of truth)
    const interactions =
      snapshot.interactions ??
      ({
        readFiles: [],
        edits: [],
      } satisfies AgentWorkspaceSnapshot['interactions']);
    const restored = FileInteractionState.fromJSON(interactions);
    // Replace the default instance with the restored state
    (state as any).interactions = restored;
    return state;
  }
}
