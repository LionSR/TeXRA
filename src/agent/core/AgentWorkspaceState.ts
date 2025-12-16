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

/** Schema for FileInteractionState serialization */
export const FileInteractionStateSnapshotSchema = z.object({
  readFiles: z.array(z.string()).default([]),
  edits: z
    .array(
      z.object({
        path: z.string(),
        added: z.number().default(0),
        removed: z.number().default(0),
      }),
    )
    .default([]),
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

  /** @internal Used by codec - prefer FileInteractionStateCodec */
  _getReadFiles(): Set<string> {
    return this.readFiles;
  }

  /** @internal Used by codec - prefer FileInteractionStateCodec */
  _getEdits(): Map<string, { added: number; removed: number }> {
    return this.edits;
  }
}

/**
 * Codec for bi-directional serialization of FileInteractionState.
 * Use .encode() to serialize and .decode() to deserialize.
 */
export const FileInteractionStateCodec = z.codec(
  FileInteractionStateSnapshotSchema,
  z.instanceof(FileInteractionState),
  {
    decode: (json: FileInteractionStateSnapshot): FileInteractionState => {
      const parsed = FileInteractionStateSnapshotSchema.parse(json);
      const state = new FileInteractionState();
      // Restore read files
      parsed.readFiles.forEach((path: string) => state.recordRead(path));
      // Restore edits directly (absolute values, not deltas)
      for (const entry of parsed.edits) {
        state._getEdits().set(entry.path, {
          added: entry.added,
          removed: entry.removed,
        });
      }
      return state;
    },
    encode: (state: FileInteractionState): FileInteractionStateSnapshot => ({
      readFiles: Array.from(state._getReadFiles()),
      edits: Array.from(state._getEdits().entries()).map(
        ([path, diff]: [string, { added: number; removed: number }]) => ({
          path,
          added: diff.added,
          removed: diff.removed,
        }),
      ),
    }),
  },
);

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

// Import todo schemas from single source of truth (eventBus/schemas)
import { TodoItemSchema, type TodoItem } from '@eventBus/schemas';

/** Schema for TodoState serialization */
export const TodoStateSnapshotSchema = z.object({
  todos: z.array(TodoItemSchema).default([]),
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

  /** @internal Used by codec */
  _setTodos(todos: TodoItem[]): void {
    this._todos = todos;
  }
}

/**
 * Codec for bi-directional serialization of TodoState.
 * Use .encode() to serialize and .decode() to deserialize.
 */
export const TodoStateCodec = z.codec(
  TodoStateSnapshotSchema,
  z.instanceof(TodoState),
  {
    decode: (json: TodoStateSnapshot): TodoState => {
      const parsed = TodoStateSnapshotSchema.parse(json);
      const state = new TodoState();
      state._setTodos([...parsed.todos]);
      return state;
    },
    encode: (state: TodoState): TodoStateSnapshot => ({
      todos: [...state.todos],
    }),
  },
);

export const ThinkingBlockSchema = z.object({
  type: z.string(),
  thinking: z.string().optional(),
  signature: z.string().optional(),
  data: z.string().optional(),
});

/**
 * Codec for media files that handles both legacy (string[]) and new (FileLocation[]) formats.
 * Legacy snapshots stored plain strings; new snapshots store FileLocation objects.
 * Uses transform to normalize legacy strings to FileLocation on decode.
 */
const MediaFileEntryCodec = z.codec(
  z.union([z.string(), FileLocationSchema]),
  FileLocationSchema,
  {
    decode: (entry: string | FileLocation): FileLocation =>
      typeof entry === 'string' ? pathToLocation(entry) : entry,
    encode: (location: FileLocation): FileLocation => location,
  },
);

/**
 * We use z.object() instead of z.strictObject() to remain backward compatible
 * with legacy workspace snapshots that may contain removed or renamed fields.
 */
export const AgentWorkspaceStateSnapshotSchema = z.object({
  assembly: z
    .object({
      lastResponse: z.string().default(''),
      accumulatedOutput: z.string().default(''),
    })
    .default({ lastResponse: '', accumulatedOutput: '' }),
  media: z
    .object({ files: z.array(MediaFileEntryCodec).default([]) })
    .default({ files: [] }),
  reasoning: z
    .object({
      thinkingBlocks: z.array(ThinkingBlockSchema).default([]),
      thinkingAdded: z.boolean().default(false),
    })
    .default({ thinkingBlocks: [], thinkingAdded: false }),
  document: z
    .object({ texcountStats: z.string().nullable().default(null) })
    .default({ texcountStats: null }),
  interactions: FileInteractionStateSnapshotSchema.default({
    readFiles: [],
    edits: [],
  }),
  todos: TodoStateSnapshotSchema.default({ todos: [] }),
});

/**
 * Output type for AgentWorkspaceState serialization.
 * Uses z.output<> to get the type after parsing (all fields required).
 */
export type AgentWorkspaceSnapshot = z.output<
  typeof AgentWorkspaceStateSnapshotSchema
>;

/** Symbol key for internal factory - only used by codec */
const INTERNAL_FACTORY = Symbol('AgentWorkspaceState.internalFactory');

/** Parameters for internal factory construction */
interface AgentWorkspaceStateParams {
  assembly: ResponseAssemblyState;
  media: MediaAttachmentState;
  reasoning: ReasoningCacheState;
  document: DocumentStatsState;
  interactions: FileInteractionState;
  serverToolContent: ServerToolContentState;
  todos: TodoState;
}

export class AgentWorkspaceState {
  public readonly assembly: ResponseAssemblyState;
  public readonly media: MediaAttachmentState;
  public readonly reasoning: ReasoningCacheState;
  public readonly document: DocumentStatsState;
  public readonly interactions: FileInteractionState;
  public readonly serverToolContent: ServerToolContentState;
  public readonly todos: TodoState;

  /** Use AgentWorkspaceState.create() for new instances */
  private constructor(params: AgentWorkspaceStateParams) {
    this.assembly = params.assembly;
    this.media = params.media;
    this.reasoning = params.reasoning;
    this.document = params.document;
    this.interactions = params.interactions;
    this.serverToolContent = params.serverToolContent;
    this.todos = params.todos;
  }

  /** Factory method to create a fresh AgentWorkspaceState */
  static create(): AgentWorkspaceState {
    return new AgentWorkspaceState({
      assembly: new ResponseAssemblyState(),
      media: new MediaAttachmentState(),
      reasoning: new ReasoningCacheState(),
      document: new DocumentStatsState(),
      interactions: new FileInteractionState(),
      serverToolContent: new ServerToolContentState(),
      todos: new TodoState(),
    });
  }

  /**
   * Internal factory for codec use only.
   * @internal Do not use directly - use AgentWorkspaceStateCodec.decode() instead.
   */
  static [INTERNAL_FACTORY](params: AgentWorkspaceStateParams): AgentWorkspaceState {
    return new AgentWorkspaceState(params);
  }

  resetReasoning(): void {
    this.reasoning.reset();
  }

  resetServerToolContent(): void {
    this.serverToolContent.reset();
  }
}

/**
 * Codec for bi-directional serialization of AgentWorkspaceState.
 * Use .encode() to serialize and .decode() to deserialize.
 * Handles legacy format migration (e.g., media files string → FileLocation).
 *
 * Note: Uses z.custom() instead of z.instanceof() because the class has a private constructor.
 */
export const AgentWorkspaceStateCodec = z.codec(
  AgentWorkspaceStateSnapshotSchema,
  z.custom<AgentWorkspaceState>((val) => val instanceof AgentWorkspaceState),
  {
    decode: (json): AgentWorkspaceState => {
      // Intentional re-parse: validates untrusted input and applies schema defaults
      // for legacy snapshots that may be missing fields or have wrong types
      const parsed = AgentWorkspaceStateSnapshotSchema.parse(json);

      // Build component states
      const assembly = new ResponseAssemblyState();
      assembly.lastResponse = parsed.assembly.lastResponse;
      assembly.accumulatedOutput = parsed.assembly.accumulatedOutput;

      const media = new MediaAttachmentState();
      // Files are already normalized to FileLocation by MediaFileEntryCodec
      media.addMediaFiles(parsed.media.files);

      const reasoning = new ReasoningCacheState();
      reasoning.thinkingBlocks.push(...parsed.reasoning.thinkingBlocks);
      reasoning.thinkingAdded = parsed.reasoning.thinkingAdded;

      const document = new DocumentStatsState();
      document.texcountStats = parsed.document.texcountStats;

      // Use nested codecs for complex state
      const interactions = FileInteractionStateCodec.decode(parsed.interactions);
      const todos = TodoStateCodec.decode(parsed.todos);

      // Use Symbol-keyed factory for type-safe internal construction
      return AgentWorkspaceState[INTERNAL_FACTORY]({
        assembly,
        media,
        reasoning,
        document,
        interactions,
        serverToolContent: new ServerToolContentState(),
        todos,
      });
    },
    encode: (state): AgentWorkspaceSnapshot => ({
      assembly: {
        lastResponse: state.assembly.lastResponse,
        accumulatedOutput: state.assembly.accumulatedOutput,
      },
      media: {
        files: [...state.media.files],
      },
      reasoning: {
        thinkingBlocks: [...state.reasoning.thinkingBlocks],
        thinkingAdded: state.reasoning.thinkingAdded,
      },
      document: {
        texcountStats: state.document.texcountStats,
      },
      interactions: FileInteractionStateCodec.encode(state.interactions) as AgentWorkspaceSnapshot['interactions'],
      todos: TodoStateCodec.encode(state.todos) as AgentWorkspaceSnapshot['todos'],
    }),
  },
);
