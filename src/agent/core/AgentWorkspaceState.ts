// Third-party imports
import { z } from 'zod';

import type { ServerToolContentBlock } from '@agent/modelHandlers/types/ServerToolTypes';
import { FlattenedEditRecordSchema } from '@tools/result';
import {
  FileLocationSchema,
  pathToLocation,
  type FileLocation,
} from '@utils/files';

/** Schema for ThinkingBlock */
export const ThinkingBlockSchema = z.object({
  type: z.string(),
  thinking: z.string().optional(),
  signature: z.string().optional(),
  data: z.string().optional(),
});

/**
 * Thinking block from reasoning models.
 * This represents the internal reasoning/thinking output from models like Claude Sonnet 4.
 * Supports both regular thinking blocks and redacted thinking blocks from Anthropic.
 */
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;

/** Schema for ResponseAssemblyState serialization */
export const ResponseAssemblyStateSnapshotSchema = z.object({
  lastResponse: z.string().prefault(''),
  accumulatedOutput: z.string().prefault(''),
});
export type ResponseAssemblyStateSnapshot = z.output<
  typeof ResponseAssemblyStateSnapshotSchema
>;

/**
 * Workspace assembly state keeps track of the model's textual output so the
 * agent can resume mid-conversation without rebuilding strings from scratch.
 */
export class ResponseAssemblyState {
  private _lastResponse = '';
  private _accumulatedOutput = '';

  /** Deserialize from a snapshot. Validates and applies schema defaults. */
  static fromSnapshot(snapshot: unknown): ResponseAssemblyState {
    const parsed = ResponseAssemblyStateSnapshotSchema.parse(snapshot);
    const state = new ResponseAssemblyState();
    state._lastResponse = parsed.lastResponse;
    state._accumulatedOutput = parsed.accumulatedOutput;
    return state;
  }

  /** Serialize to a snapshot. */
  toSnapshot(): ResponseAssemblyStateSnapshot {
    return {
      lastResponse: this._lastResponse,
      accumulatedOutput: this._accumulatedOutput,
    };
  }

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

/** Schema for FileInteractionState serialization */
export const FileInteractionStateSnapshotSchema = z.object({
  readFiles: z.array(z.string()).prefault([]),
  edits: z.array(FlattenedEditRecordSchema).prefault([]),
});
/**
 * Output type for FileInteractionState serialization.
 * Uses z.output<> to get the type after parsing (all fields required).
 */
export type FileInteractionStateSnapshot = z.output<
  typeof FileInteractionStateSnapshotSchema
>;

export class FileInteractionState {
  private readonly readFiles = new Set<string>();
  private readonly edits = new Map<
    string,
    { added: number; removed: number }
  >();

  /** Deserialize from a snapshot. Validates and applies schema defaults. */
  static fromSnapshot(snapshot: unknown): FileInteractionState {
    const parsed = FileInteractionStateSnapshotSchema.parse(snapshot);
    const state = new FileInteractionState();
    parsed.readFiles.forEach((path) => state.readFiles.add(path));
    for (const entry of parsed.edits) {
      state.edits.set(entry.path, {
        added: entry.added,
        removed: entry.removed,
      });
    }
    return state;
  }

  /** Serialize to a snapshot. */
  toSnapshot(): FileInteractionStateSnapshot {
    return {
      readFiles: Array.from(this.readFiles),
      edits: Array.from(this.edits.entries()).map(([path, diff]) => ({
        path,
        added: diff.added,
        removed: diff.removed,
      })),
    };
  }

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
}

/**
 * Schema for legacy media file entries.
 * Legacy snapshots stored plain strings; new snapshots store FileLocation objects.
 * Transform normalizes legacy strings to FileLocation on parse.
 */
const MediaFileEntrySchema = z
  .union([z.string(), FileLocationSchema])
  .transform(
    (entry): FileLocation =>
      typeof entry === 'string' ? pathToLocation(entry) : entry,
  );

/** Schema for MediaAttachmentState serialization */
export const MediaAttachmentStateSnapshotSchema = z.object({
  files: z.array(MediaFileEntrySchema).prefault([]),
});
export type MediaAttachmentStateSnapshot = z.output<
  typeof MediaAttachmentStateSnapshotSchema
>;

export class MediaAttachmentState {
  public readonly files: FileLocation[] = [];
  /** Set of absolute paths for O(1) deduplication lookups */
  private readonly pathSet = new Set<string>();

  /** Deserialize from a snapshot. Validates, applies defaults, and normalizes legacy formats. */
  static fromSnapshot(snapshot: unknown): MediaAttachmentState {
    const parsed = MediaAttachmentStateSnapshotSchema.parse(snapshot);
    const state = new MediaAttachmentState();
    state.addMediaFiles(parsed.files);
    return state;
  }

  /** Serialize to a snapshot. */
  toSnapshot(): MediaAttachmentStateSnapshot {
    return { files: [...this.files] };
  }

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

/** Schema for ReasoningCacheState serialization */
export const ReasoningCacheStateSnapshotSchema = z.object({
  thinkingBlocks: z.array(ThinkingBlockSchema).prefault([]),
  thinkingAdded: z.boolean().prefault(false),
});
export type ReasoningCacheStateSnapshot = z.output<
  typeof ReasoningCacheStateSnapshotSchema
>;

export class ReasoningCacheState {
  public thinkingBlocks: ThinkingBlock[] = [];
  public thinkingAdded = false;

  /** Deserialize from a snapshot. Validates and applies schema defaults. */
  static fromSnapshot(snapshot: unknown): ReasoningCacheState {
    const parsed = ReasoningCacheStateSnapshotSchema.parse(snapshot);
    const state = new ReasoningCacheState();
    state.thinkingBlocks = [...parsed.thinkingBlocks];
    state.thinkingAdded = parsed.thinkingAdded;
    return state;
  }

  /** Serialize to a snapshot. */
  toSnapshot(): ReasoningCacheStateSnapshot {
    return {
      thinkingBlocks: [...this.thinkingBlocks],
      thinkingAdded: this.thinkingAdded,
    };
  }

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

/** Schema for DocumentStatsState serialization */
export const DocumentStatsStateSnapshotSchema = z.object({
  texcountStats: z.string().nullable().prefault(null),
});
export type DocumentStatsStateSnapshot = z.output<
  typeof DocumentStatsStateSnapshotSchema
>;

export class DocumentStatsState {
  public texcountStats: string | null = null;

  /** Deserialize from a snapshot. Validates and applies schema defaults. */
  static fromSnapshot(snapshot: unknown): DocumentStatsState {
    const parsed = DocumentStatsStateSnapshotSchema.parse(snapshot);
    const state = new DocumentStatsState();
    state.texcountStats = parsed.texcountStats;
    return state;
  }

  /** Serialize to a snapshot. */
  toSnapshot(): DocumentStatsStateSnapshot {
    return { texcountStats: this.texcountStats };
  }

  updateTeXCountStats(stats: string | null): void {
    this.texcountStats = stats;
  }
}

// Import todo schemas from single source of truth (eventBus/schemas)
import { TodoItemSchema, type TodoItem } from '@eventBus/schemas';

/** Schema for TodoState serialization */
export const TodoStateSnapshotSchema = z.object({
  todos: z.array(TodoItemSchema).prefault([]),
});
/**
 * Output type for TodoState serialization.
 * Uses z.output<> to get the type after parsing (all fields required).
 */
export type TodoStateSnapshot = z.output<typeof TodoStateSnapshotSchema>;

/**
 * State for managing todo items during tool-use sessions.
 * Provides task tracking and progress visibility for agents.
 */
export class TodoState {
  private _todos: TodoItem[] = [];
  private _onUpdate?: (todos: TodoItem[]) => void;

  /** Deserialize from a snapshot. Validates and applies schema defaults. */
  static fromSnapshot(snapshot: unknown): TodoState {
    const parsed = TodoStateSnapshotSchema.parse(snapshot);
    const state = new TodoState();
    state._todos = [...parsed.todos];
    return state;
  }

  /** Serialize to a snapshot. */
  toSnapshot(): TodoStateSnapshot {
    return { todos: [...this._todos] };
  }

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
   * Clear the update callback.
   * Should be called when disposing resources to prevent memory leaks.
   */
  clearOnUpdate(): void {
    this._onUpdate = undefined;
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
}

/**
 * Composite schema for AgentWorkspaceState serialization.
 * Uses z.object() (not strictObject) to remain backward compatible
 * with legacy workspace snapshots that may contain removed or renamed fields.
 */
export const AgentWorkspaceStateSnapshotSchema = z.object({
  assembly: ResponseAssemblyStateSnapshotSchema.prefault({
    lastResponse: '',
    accumulatedOutput: '',
  }),
  media: MediaAttachmentStateSnapshotSchema.prefault({ files: [] }),
  reasoning: ReasoningCacheStateSnapshotSchema.prefault({
    thinkingBlocks: [],
    thinkingAdded: false,
  }),
  document: DocumentStatsStateSnapshotSchema.prefault({ texcountStats: null }),
  interactions: FileInteractionStateSnapshotSchema.prefault({
    readFiles: [],
    edits: [],
  }),
  todos: TodoStateSnapshotSchema.prefault({ todos: [] }),
});

/**
 * Output type for AgentWorkspaceState serialization.
 * Uses z.output<> to get the type after parsing (all fields required).
 */
export type AgentWorkspaceSnapshot = z.output<
  typeof AgentWorkspaceStateSnapshotSchema
>;

export class AgentWorkspaceState {
  public readonly assembly: ResponseAssemblyState;
  public readonly media: MediaAttachmentState;
  public readonly reasoning: ReasoningCacheState;
  public readonly document: DocumentStatsState;
  public readonly interactions: FileInteractionState;
  public readonly serverToolContent: ServerToolContentState;
  public readonly todos: TodoState;

  private constructor(
    assembly: ResponseAssemblyState,
    media: MediaAttachmentState,
    reasoning: ReasoningCacheState,
    document: DocumentStatsState,
    interactions: FileInteractionState,
    serverToolContent: ServerToolContentState,
    todos: TodoState,
  ) {
    this.assembly = assembly;
    this.media = media;
    this.reasoning = reasoning;
    this.document = document;
    this.interactions = interactions;
    this.serverToolContent = serverToolContent;
    this.todos = todos;
  }

  /** Factory method to create a fresh AgentWorkspaceState */
  static create(): AgentWorkspaceState {
    return new AgentWorkspaceState(
      new ResponseAssemblyState(),
      new MediaAttachmentState(),
      new ReasoningCacheState(),
      new DocumentStatsState(),
      new FileInteractionState(),
      new ServerToolContentState(),
      new TodoState(),
    );
  }

  /** Deserialize from a snapshot. Validates, applies defaults, and handles legacy formats. */
  static fromSnapshot(snapshot: unknown): AgentWorkspaceState {
    const parsed = AgentWorkspaceStateSnapshotSchema.parse(snapshot);
    return new AgentWorkspaceState(
      ResponseAssemblyState.fromSnapshot(parsed.assembly),
      MediaAttachmentState.fromSnapshot(parsed.media),
      ReasoningCacheState.fromSnapshot(parsed.reasoning),
      DocumentStatsState.fromSnapshot(parsed.document),
      FileInteractionState.fromSnapshot(parsed.interactions),
      new ServerToolContentState(), // Ephemeral - not serialized
      TodoState.fromSnapshot(parsed.todos),
    );
  }

  /** Serialize to a snapshot. */
  toSnapshot(): AgentWorkspaceSnapshot {
    return {
      assembly: this.assembly.toSnapshot(),
      media: this.media.toSnapshot(),
      reasoning: this.reasoning.toSnapshot(),
      document: this.document.toSnapshot(),
      interactions: this.interactions.toSnapshot(),
      todos: this.todos.toSnapshot(),
    };
  }

  resetReasoning(): void {
    this.reasoning.reset();
  }

  resetServerToolContent(): void {
    this.serverToolContent.reset();
  }
}
