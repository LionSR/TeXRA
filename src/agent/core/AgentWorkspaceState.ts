import { z } from 'zod';

import type { ServerToolContentBlock } from '@agent/modelHandlers/types/ServerToolTypes';
import {
  TodoItemSchema,
  FileLocationSchema,
  type TodoItem,
  type FileLocation,
} from '@shared/schemas';
import { FlattenedEditRecordSchema } from '@tools/result';
import { pathToLocation } from '@utils/files';

/** Schema for thinking blocks (used by model handlers). */
const ThinkingBlockSchema = z.object({
  type: z.string(),
  thinking: z.string().optional(),
  signature: z.string().optional(),
  data: z.string().optional(),
});

export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;

/** Internal schema for response assembly state. */
const ResponseAssemblyStateSchema = z.object({
  lastResponse: z.string().prefault(''),
  accumulatedOutput: z.string().prefault(''),
});

type ResponseAssemblyState = z.output<typeof ResponseAssemblyStateSchema>;

/** Internal schema for file interaction state snapshot. */
const FileInteractionStateSnapshotSchema = z.object({
  readFiles: z.array(z.string()).prefault([]),
  edits: z.array(FlattenedEditRecordSchema).prefault([]),
  toolCallCount: z.number().nonnegative().prefault(0),
});

type FileInteractionStateSnapshot = z.output<
  typeof FileInteractionStateSnapshotSchema
>;

export class FileInteractionState {
  private readonly readFiles = new Set<string>();
  private readonly edits = new Map<
    string,
    { added: number; removed: number }
  >();
  private _toolCallCount = 0;

  /** Total number of tool calls executed in this session. */
  get toolCallCount(): number {
    return this._toolCallCount;
  }

  static fromSnapshot(snapshot: unknown): FileInteractionState {
    const parsed = FileInteractionStateSnapshotSchema.parse(snapshot);
    const state = new FileInteractionState();
    for (const filePath of parsed.readFiles) {
      state.readFiles.add(filePath);
    }
    for (const entry of parsed.edits) {
      state.edits.set(entry.path, {
        added: entry.added,
        removed: entry.removed,
      });
    }
    state._toolCallCount = parsed.toolCallCount;
    return state;
  }

  toSnapshot(): FileInteractionStateSnapshot {
    return {
      readFiles: [...this.readFiles],
      edits: [...this.edits.entries()].map(([path, diff]) => ({
        path,
        added: diff.added,
        removed: diff.removed,
      })),
      toolCallCount: this._toolCallCount,
    };
  }

  /** Record that a tool call was executed. */
  recordToolCall(): void {
    this._toolCallCount += 1;
  }

  /** Paths of all files with recorded edits. */
  get editedFilePaths(): string[] {
    return [...this.edits.keys()];
  }

  recordRead(path: string | undefined | null): void {
    if (!path) return;
    this.readFiles.add(path);
  }

  hasRead(path: string | undefined | null): boolean {
    if (!path) return false;
    return this.readFiles.has(path);
  }

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

      this.updateEditMap(this.edits, path, added, removed);
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

const MediaFileEntrySchema = z
  .union([z.string(), FileLocationSchema])
  .transform(
    (entry): FileLocation =>
      typeof entry === 'string' ? pathToLocation(entry) : entry,
  );

/** Internal schema for media attachment state snapshot. */
const MediaAttachmentStateSnapshotSchema = z.object({
  files: z.array(MediaFileEntrySchema).prefault([]),
});
type MediaAttachmentStateSnapshot = z.output<
  typeof MediaAttachmentStateSnapshotSchema
>;

export class MediaAttachmentState {
  public readonly files: FileLocation[] = [];
  private readonly pathSet = new Set<string>();

  static fromSnapshot(snapshot: unknown): MediaAttachmentState {
    const parsed = MediaAttachmentStateSnapshotSchema.parse(snapshot);
    const state = new MediaAttachmentState();
    state.addMediaFiles(parsed.files);
    return state;
  }

  toSnapshot(): MediaAttachmentStateSnapshot {
    return { files: [...this.files] };
  }

  private addFile(location: FileLocation): void {
    if (!this.pathSet.has(location.absolutePath)) {
      this.pathSet.add(location.absolutePath);
      this.files.push(location);
    }
  }

  addMediaFiles(locations: FileLocation[]): void {
    for (const location of locations) {
      this.addFile(location);
    }
  }

  hasFile(absolutePath: string): boolean {
    return this.pathSet.has(absolutePath);
  }
}

/** Internal schema for reasoning cache state. */
const ReasoningCacheStateSchema = z.object({
  thinkingBlocks: z.array(ThinkingBlockSchema).prefault([]),
  thinkingAdded: z.boolean().prefault(false),
});

type ReasoningCacheState = z.output<typeof ReasoningCacheStateSchema>;

/** Internal schema for server tool content state. */
const ServerToolContentStateSchema = z.object({
  // ServerToolContentBlock is internal state from SDK responses, validated upstream by the SDK
  contentBlocks: z.array(z.custom<ServerToolContentBlock>()).prefault(() => []),
  lastAssistantContent: z.array(z.unknown()).prefault(() => []),
});

type ServerToolContentState = z.output<typeof ServerToolContentStateSchema>;

/** Callback shape for task state updates. */
export interface TaskStateUpdate {
  todos: TodoItem[];
  summary: string | null;
}

/** Internal schema for task state snapshot (unified todo + plan). */
const TaskStateSnapshotSchema = z.object({
  todos: z.array(TodoItemSchema).prefault([]),
  summary: z.string().nullable().prefault(null),
});

type TaskStateSnapshot = z.output<typeof TaskStateSnapshotSchema>;

/**
 * Unified task tracking state.
 *
 * Manages both lightweight todos and richer plan-style items in a single list.
 * The optional `summary` provides a high-level overview (previously Plan.summary).
 *
 * Exposes `TodoState` and `PlanState` facades for backward compatibility
 * during the migration period.
 */
export class TaskState {
  private _todos: TodoItem[] = [];
  private _summary: string | null = null;
  private _onUpdate?: (update: TaskStateUpdate) => void;

  static fromSnapshot(snapshot: unknown): TaskState {
    const parsed = TaskStateSnapshotSchema.parse(snapshot);
    const state = new TaskState();
    state._todos = [...parsed.todos];
    state._summary = parsed.summary;
    return state;
  }

  toSnapshot(): TaskStateSnapshot {
    return {
      todos: this._todos.map((t) => ({
        ...t,
        files: t.files ? [...t.files] : undefined,
      })),
      summary: this._summary,
    };
  }

  get todos(): TodoItem[] {
    return this._todos;
  }

  get summary(): string | null {
    return this._summary;
  }

  setOnUpdate(callback: (update: TaskStateUpdate) => void): void {
    this._onUpdate = callback;
  }

  clearOnUpdate(): void {
    this._onUpdate = undefined;
  }

  updateTodos(todos: TodoItem[], summary?: string | null): void {
    const newSummary = summary !== undefined ? summary : this._summary;
    if (
      this._todosEqual(this._todos, todos) &&
      this._summary === newSummary
    ) {
      return;
    }
    this._todos = todos;
    this._summary = newSummary;
    this._onUpdate?.({ todos: this._todos, summary: this._summary });
  }

  /** Clear the summary without changing todos. */
  clearSummary(): void {
    if (this._summary === null) return;
    this._summary = null;
    this._onUpdate?.({ todos: this._todos, summary: null });
  }

  private _todosEqual(a: TodoItem[], b: TodoItem[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i],
        bi = b[i];
      if (!ai || !bi) return false;
      if (
        ai.content !== bi.content ||
        ai.status !== bi.status ||
        ai.activeForm !== bi.activeForm ||
        ai.description !== bi.description ||
        !this._arraysEqual(ai.files, bi.files)
      ) {
        return false;
      }
    }
    return true;
  }

  private _arraysEqual(
    a: string[] | undefined,
    b: string[] | undefined,
  ): boolean {
    if (a === b) return true;
    if (!a || !b) return a === b;
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }

  reset(): void {
    this._todos = [];
    this._summary = null;
  }
}

/**
 * @deprecated Use TaskState directly. Kept for backward compatibility.
 */
export type TodoState = TaskState;
export const TodoState = TaskState;

/**
 * @deprecated Use TaskState directly. Kept for backward compatibility.
 */
export type PlanState = TaskState;

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
  tasks: TaskStateSnapshotSchema.prefault({ todos: [], summary: null }),
});

export type AgentWorkspaceSnapshot = z.output<
  typeof AgentWorkspaceStateSnapshotSchema
>;

export class AgentWorkspaceState {
  public readonly assembly: ResponseAssemblyState;
  public readonly media: MediaAttachmentState;
  public readonly reasoning: ReasoningCacheState;
  public readonly interactions: FileInteractionState;
  public readonly serverToolContent: ServerToolContentState;
  public readonly tasks: TaskState;

  private constructor(
    assembly: ResponseAssemblyState,
    media: MediaAttachmentState,
    reasoning: ReasoningCacheState,
    interactions: FileInteractionState,
    serverToolContent: ServerToolContentState,
    tasks: TaskState,
  ) {
    this.assembly = assembly;
    this.media = media;
    this.reasoning = reasoning;
    this.interactions = interactions;
    this.serverToolContent = serverToolContent;
    this.tasks = tasks;
  }

  static create(): AgentWorkspaceState {
    return new AgentWorkspaceState(
      ResponseAssemblyStateSchema.parse({}),
      new MediaAttachmentState(),
      ReasoningCacheStateSchema.parse({}),
      new FileInteractionState(),
      ServerToolContentStateSchema.parse({}),
      new TaskState(),
    );
  }

  /**
   * Create an empty snapshot without instantiating a full class.
   * Use at initialization sites that only need the serializable shape
   * (e.g., constructing initial ReflectionFlowShared).
   */
  static emptySnapshot(): AgentWorkspaceSnapshot {
    return AgentWorkspaceStateSnapshotSchema.parse({});
  }

  static fromSnapshot(snapshot: unknown): AgentWorkspaceState {
    const parsed = AgentWorkspaceStateSnapshotSchema.parse(snapshot);
    return new AgentWorkspaceState(
      parsed.assembly,
      MediaAttachmentState.fromSnapshot(parsed.media),
      parsed.reasoning,
      FileInteractionState.fromSnapshot(parsed.interactions),
      ServerToolContentStateSchema.parse({}),
      TaskState.fromSnapshot(parsed.tasks),
    );
  }

  toSnapshot(options?: {
    excludeAssemblyStrings?: boolean;
  }): AgentWorkspaceSnapshot {
    const exclude = options?.excludeAssemblyStrings ?? false;
    return {
      assembly: {
        lastResponse: exclude ? '' : this.assembly.lastResponse,
        accumulatedOutput: exclude ? '' : this.assembly.accumulatedOutput,
      },
      media: this.media.toSnapshot(),
      reasoning: {
        ...this.reasoning,
        thinkingBlocks: [...this.reasoning.thinkingBlocks],
      },
      interactions: this.interactions.toSnapshot(),
      tasks: this.tasks.toSnapshot(),
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
