import { z } from 'zod';

import {
  TodoItemSchema,
  FileLocationSchema,
  type TodoItem,
  type FileLocation,
} from '@shared/schemas';
import type { ServerToolContentBlock } from '@agent/modelHandlers/types/ServerToolTypes';
import { FlattenedEditRecordSchema } from '@tools/result';
import { pathToLocation } from '@utils/files';

/** Internal schema for thinking blocks. */
const ThinkingBlockSchema = z.object({
  type: z.string(),
  thinking: z.string().optional(),
  signature: z.string().optional(),
  data: z.string().optional(),
});

type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;

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
  contentBlocks: z.array(z.custom<ServerToolContentBlock>()).prefault(() => []),
  lastAssistantContent: z.array(z.unknown()).prefault(() => []),
});

type ServerToolContentState = z.output<typeof ServerToolContentStateSchema>;

/** Internal schema for todo state snapshot. */
const TodoStateSnapshotSchema = z.object({
  todos: z.array(TodoItemSchema).prefault([]),
});

type TodoStateSnapshot = z.output<typeof TodoStateSnapshotSchema>;

export class TodoState {
  private _todos: TodoItem[] = [];
  private _onUpdate?: (todos: TodoItem[]) => void;

  static fromSnapshot(snapshot: unknown): TodoState {
    const parsed = TodoStateSnapshotSchema.parse(snapshot);
    const state = new TodoState();
    state._todos = [...parsed.todos];
    return state;
  }

  toSnapshot(): TodoStateSnapshot {
    return { todos: [...this._todos] };
  }

  get todos(): TodoItem[] {
    return this._todos;
  }

  setOnUpdate(callback: (todos: TodoItem[]) => void): void {
    this._onUpdate = callback;
  }

  clearOnUpdate(): void {
    this._onUpdate = undefined;
  }

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

  reset(): void {
    this._todos = [];
  }
}

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

export type AgentWorkspaceSnapshot = z.output<
  typeof AgentWorkspaceStateSnapshotSchema
>;

export class AgentWorkspaceState {
  public readonly assembly: ResponseAssemblyState;
  public readonly media: MediaAttachmentState;
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

  static create(): AgentWorkspaceState {
    return new AgentWorkspaceState(
      ResponseAssemblyStateSchema.parse({}),
      new MediaAttachmentState(),
      ReasoningCacheStateSchema.parse({}),
      new FileInteractionState(),
      ServerToolContentStateSchema.parse({}),
      new TodoState(),
    );
  }

  static fromSnapshot(snapshot: unknown): AgentWorkspaceState {
    const parsed = AgentWorkspaceStateSnapshotSchema.parse(snapshot);
    return new AgentWorkspaceState(
      parsed.assembly,
      MediaAttachmentState.fromSnapshot(parsed.media),
      parsed.reasoning,
      FileInteractionState.fromSnapshot(parsed.interactions),
      ServerToolContentStateSchema.parse({}),
      TodoState.fromSnapshot(parsed.todos),
    );
  }

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
