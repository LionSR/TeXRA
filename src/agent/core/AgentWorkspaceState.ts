// Third-party imports
import { z } from 'zod';

import type { ServerToolContentBlock } from '@agent/modelHandlers/types/ServerToolTypes';
import {
  FileLocationSchema,
  pathToLocation,
  type FileLocation,
} from '@utils/files';

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
  public readonly files: FileLocation[] = [];
  /** Set of absolute paths for O(1) deduplication lookups */
  private readonly pathSet = new Set<string>();

  /**
   * Add a single media file to the attachment state.
   * Used internally and during deserialization.
   */
  private addFile(location: FileLocation): void {
    if (!this.pathSet.has(location.absolutePath)) {
      this.pathSet.add(location.absolutePath);
      this.files.push(location);
    }
  }

  /**
   * Add media files to the attachment state.
   * Deduplicates by absolute path using O(1) Set lookups.
   */
  addMediaFiles(locations: FileLocation[]): void {
    for (const location of locations) {
      this.addFile(location);
    }
  }

  /**
   * Check if a file is already in the media list by absolute path.
   * O(1) lookup using internal Set.
   */
  hasFile(absolutePath: string): boolean {
    return this.pathSet.has(absolutePath);
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

/**
 * Cache for server tool content blocks (e.g., web_search results from Anthropic).
 * These blocks need to be preserved in the assistant message when local tools are also present.
 *
 * **EPHEMERAL STATE**: This state is intentionally NOT serialized to snapshots.
 * Server tool content is only relevant within a single tool use cycle and is automatically
 * cleared after being consumed by `createToolUseFollowUpMessages()` or when the end-turn
 * branch is taken. It does not need to survive state restoration since:
 * 1. The response object containing the content is not persisted
 * 2. Upon restoration, the model will generate fresh server tool content if needed
 * 3. Stale content would cause duplicate blocks in conversation history
 */
export class ServerToolContentState {
  /**
   * Server tool content blocks extracted from the model response.
   * These include server_tool_use, web_search_tool_result (Anthropic),
   * and web_search_call (OpenAI) blocks.
   * Cleared after being consumed by createToolUseFollowUpMessages().
   */
  public contentBlocks: ServerToolContentBlock[] = [];

  /**
   * Full assistant content blocks from the last response, excluding tool_use.
   * Preserves original order for building correct follow-up messages.
   * Includes: thinking, text, server_tool_use, web_search_tool_result blocks.
   * Cleared after being consumed by createToolUseFollowUpMessages().
   *
   * Typed as unknown[] because content block types differ across providers:
   * - Anthropic: ContentBlockParam (thinking, text, server_tool_use, etc.)
   * - OpenAI: ResponseInputItem (message, function_call, web_search_call, etc.)
   * Each handler casts to provider-specific types when consuming.
   */
  public lastAssistantContent: unknown[] = [];

  reset(): void {
    this.contentBlocks = [];
    this.lastAssistantContent = [];
  }
}

export class DocumentStatsState {
  public texcountStats: string | null = null;

  updateTeXCountStats(stats: string | null): void {
    this.texcountStats = stats;
  }
}

// Re-export todo types from single source of truth (eventBus/schemas)
export {
  TodoStatusSchema,
  TodoItemSchema,
  type TodoStatus,
  type TodoItem,
} from '@eventBus/schemas';

// Import for internal use in this file
import { TodoItemSchema, type TodoItem } from '@eventBus/schemas';

/**
 * State for managing todo items during tool-use sessions.
 * Provides task tracking and progress visibility for agents.
 */
export class TodoState {
  private _todos: TodoItem[] = [];
  private _onUpdate?: (todos: TodoItem[]) => void;

  get todos(): TodoItem[] {
    return this._todos;
  }

  /**
   * Set the callback to be called when todos are updated.
   * Used to emit events to the progress view.
   */
  setOnUpdate(callback: (todos: TodoItem[]) => void): void {
    this._onUpdate = callback;
  }

  /**
   * Update the entire todo list.
   * Triggers the onUpdate callback if set.
   */
  updateTodos(todos: TodoItem[]): void {
    this._todos = todos;
    this._onUpdate?.(todos);
  }

  /**
   * Clear all todos.
   */
  reset(): void {
    this._todos = [];
  }

  toJSON(): { todos: TodoItem[] } {
    return { todos: [...this._todos] };
  }

  static fromJSON(data: { todos?: TodoItem[] } | null): TodoState {
    const state = new TodoState();
    if (data?.todos) {
      state._todos = [...data.todos];
    }
    return state;
  }
}

export const ThinkingBlockSchema = z.object({
  type: z.string(),
  thinking: z.string().optional(),
  signature: z.string().optional(),
  data: z.string().optional(),
});

/**
 * Schema for media files that handles both legacy (string[]) and new (FileLocation[]) formats.
 * Legacy snapshots stored plain strings; new snapshots store FileLocation objects.
 */
const MediaFileEntrySchema = z.union([
  z.string(), // Legacy format: plain path string
  FileLocationSchema, // New format: FileLocation object
]);

/**
 * We use z.object() instead of z.strictObject() to remain backward compatible
 * with legacy workspace snapshots that may contain removed or renamed fields.
 */
export const AgentWorkspaceStateSnapshotSchema = z.object({
  assembly: z.object({
    lastResponse: z.string(),
    accumulatedOutput: z.string(),
  }),
  media: z.object({ files: z.array(MediaFileEntrySchema) }),
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
    .prefault({
      readFiles: [],
      edits: [],
    }),
  todos: z
    .object({
      todos: z.array(TodoItemSchema),
    })
    .optional()
    .prefault({ todos: [] }),
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
  public readonly serverToolContent = new ServerToolContentState();
  public readonly todos = new TodoState();

  resetReasoning(): void {
    this.reasoning.reset();
  }

  resetServerToolContent(): void {
    this.serverToolContent.reset();
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
      todos: this.todos.toJSON(),
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

    // Restore media files, converting legacy strings to FileLocation
    const restoredMediaFiles: FileLocation[] = snapshot.media.files.map(
      (entry) => (typeof entry === 'string' ? pathToLocation(entry) : entry),
    );
    state.media.addMediaFiles(restoredMediaFiles);

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

    // Restore todos
    const todosData = snapshot.todos ?? { todos: [] };
    const restoredTodos = TodoState.fromJSON(todosData);
    (state as any).todos = restoredTodos;

    return state;
  }
}
