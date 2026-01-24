// Third-party imports
import { z } from 'zod';

import type { ServerToolContentBlock } from '@agent/modelHandlers/types/ServerToolTypes';
import { FlattenedEditRecordSchema } from '@tools/result';
import { FileLocationSchema, type FileLocation } from '@shared/schemas';
import { pathToLocation } from '@utils/files';

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

// ============================================================================
// ResponseAssemblyState - Plain object with schema (no class needed)
// ============================================================================

/**
 * Schema for response assembly state.
 * Tracks model's textual output for mid-conversation resumption.
 */
export const ResponseAssemblyStateSchema = z.object({
  lastResponse: z.string().prefault(''),
  accumulatedOutput: z.string().prefault(''),
});

/** Response assembly state - plain object type derived from schema */
export type ResponseAssemblyState = z.output<
  typeof ResponseAssemblyStateSchema
>;

/** Default ResponseAssemblyState values (for inline initialization). */
const RESPONSE_ASSEMBLY_DEFAULTS: ResponseAssemblyState = {
  lastResponse: '',
  accumulatedOutput: '',
};

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
      readFiles: [...this.readFiles],
      edits: [...this.edits.entries()].map(([path, diff]) => ({
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
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const entry of edits) {
      const path = entry?.path;
      if (!path) continue;

      const added = entry.lineChanges?.added ?? 0;
      const removed = entry.lineChanges?.removed ?? 0;

      // Update cumulative edits
      this.updateEditMap(this.edits, path, added, removed);
      // Update per-call edits
      this.updateEditMap(perCallEdits, path, added, removed);

      totalAdded += added;
      totalRemoved += removed;
    }

    const editsForCall = [...perCallEdits.entries()].map(([path, diff]) => ({
      path,
      lineChanges:
        diff.added || diff.removed
          ? { added: diff.added, removed: diff.removed }
          : undefined,
    }));

    return {
      edits: editsForCall,
      lineChanges:
        totalAdded || totalRemoved
          ? { added: totalAdded, removed: totalRemoved }
          : undefined,
    };
  }

  private updateEditMap(
    map: Map<string, { added: number; removed: number }>,
    path: string,
    added: number,
    removed: number,
  ): void {
    const existing = map.get(path);
    if (existing) {
      existing.added += added;
      existing.removed += removed;
    } else {
      map.set(path, { added, removed });
    }
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

// ============================================================================
// ReasoningCacheState - Plain object with schema (no class needed)
// ============================================================================

/**
 * Schema for reasoning cache state.
 * Tracks thinking blocks from reasoning models like Claude Sonnet 4.
 */
export const ReasoningCacheStateSchema = z.object({
  thinkingBlocks: z.array(ThinkingBlockSchema).prefault([]),
  thinkingAdded: z.boolean().prefault(false),
});

/** Reasoning cache state - plain object type derived from schema */
export type ReasoningCacheState = z.output<typeof ReasoningCacheStateSchema>;

/** Default ReasoningCacheState values (for inline initialization). */
const REASONING_CACHE_DEFAULTS: ReasoningCacheState = {
  thinkingBlocks: [],
  thinkingAdded: false,
};

// ============================================================================
// ServerToolContentState - Plain object (no class needed)
// ============================================================================

/**
 * Cache for server tool content blocks (e.g., web_search results from Anthropic).
 * These blocks need to be preserved in the assistant message when local tools are also present.
 *
 * **EPHEMERAL STATE**: This state is intentionally NOT serialized to snapshots.
 * Server tool content is only relevant within a single tool use cycle and is automatically
 * cleared after being consumed by `createToolUseFollowUpMessages()` or when the end-turn
 * branch is taken.
 */
export interface ServerToolContentState {
  /** Server tool content blocks from model response (server_tool_use, web_search_tool_result, etc.) */
  contentBlocks: ServerToolContentBlock[];
  /** Full assistant content blocks from last response, excluding tool_use. Typed as unknown[] for cross-provider compatibility. */
  lastAssistantContent: unknown[];
}

/** Default ServerToolContentState values (for inline initialization). */
const SERVER_TOOL_CONTENT_DEFAULTS: ServerToolContentState = {
  contentBlocks: [],
  lastAssistantContent: [],
};

// Import todo schemas from single source of truth (shared schemas)
import { TodoItemSchema, type TodoItem } from '@shared/schemas';

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
   * Only triggers callback if todos actually changed.
   */
  updateTodos(todos: TodoItem[]): void {
    if (this._todosEqual(this._todos, todos)) return;
    this._todos = todos;
    this._onUpdate?.(todos);
  }

  private _todosEqual(a: TodoItem[], b: TodoItem[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i],
        bi = b[i];
      if (!ai || !bi) return false; // Guard against sparse arrays
      if (
        ai.content !== bi.content ||
        ai.status !== bi.status ||
        ai.activeForm !== bi.activeForm
      ) {
        return false;
      }
    }
    return true;
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
  assembly: ResponseAssemblyStateSchema.prefault({
    lastResponse: '',
    accumulatedOutput: '',
  }),
  media: MediaAttachmentStateSnapshotSchema.prefault({ files: [] }),
  reasoning: ReasoningCacheStateSchema.prefault({
    thinkingBlocks: [],
    thinkingAdded: false,
  }),
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
  /** Plain object - use direct property assignment */
  public readonly assembly: ResponseAssemblyState;
  public readonly media: MediaAttachmentState;
  /** Plain object - use direct property assignment */
  public readonly reasoning: ReasoningCacheState;
  public readonly interactions: FileInteractionState;
  public readonly serverToolContent: ServerToolContentState;
  public readonly todos: TodoState;

  private constructor(
    assembly: ResponseAssemblyState,
    media: MediaAttachmentState,
    reasoning: ReasoningCacheState,
    interactions: FileInteractionState,
    serverToolContent: ServerToolContentState,
    todos: TodoState,
  ) {
    this.assembly = assembly;
    this.media = media;
    this.reasoning = reasoning;
    this.interactions = interactions;
    this.serverToolContent = serverToolContent;
    this.todos = todos;
  }

  /** Factory method to create a fresh AgentWorkspaceState */
  static create(): AgentWorkspaceState {
    return new AgentWorkspaceState(
      { ...RESPONSE_ASSEMBLY_DEFAULTS },
      new MediaAttachmentState(),
      { ...REASONING_CACHE_DEFAULTS },
      new FileInteractionState(),
      { ...SERVER_TOOL_CONTENT_DEFAULTS },
      new TodoState(),
    );
  }

  /** Deserialize from a snapshot. Validates, applies defaults, and handles legacy formats. */
  static fromSnapshot(snapshot: unknown): AgentWorkspaceState {
    const parsed = AgentWorkspaceStateSnapshotSchema.parse(snapshot);
    return new AgentWorkspaceState(
      parsed.assembly, // Plain object - schema already validates
      MediaAttachmentState.fromSnapshot(parsed.media),
      parsed.reasoning, // Plain object - schema already validates
      FileInteractionState.fromSnapshot(parsed.interactions),
      { ...SERVER_TOOL_CONTENT_DEFAULTS }, // Ephemeral - not serialized
      TodoState.fromSnapshot(parsed.todos),
    );
  }

  /** Serialize to a snapshot. */
  toSnapshot(): AgentWorkspaceSnapshot {
    return {
      assembly: {
        lastResponse: this.assembly.lastResponse,
        accumulatedOutput: this.assembly.accumulatedOutput,
      },
      media: this.media.toSnapshot(),
      reasoning: {
        thinkingBlocks: [...this.reasoning.thinkingBlocks],
        thinkingAdded: this.reasoning.thinkingAdded,
      },
      interactions: this.interactions.toSnapshot(),
      todos: this.todos.toSnapshot(),
    };
  }

  resetReasoning(): void {
    this.reasoning.thinkingBlocks = [];
    this.reasoning.thinkingAdded = false;
  }

  resetServerToolContent(): void {
    this.serverToolContent.contentBlocks = [];
    this.serverToolContent.lastAssistantContent = [];
  }
}
