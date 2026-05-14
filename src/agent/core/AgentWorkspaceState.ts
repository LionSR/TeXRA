import { z } from 'zod';

import type { ServerToolContentBlock } from '@agent/modelHandlers/types/ServerToolTypes';
import {
  FileLocationSchema,
  WorkPlanSnapshotSchema,
  type TodoItem,
  type Plan,
  type FileLocation,
  type WorkPlanSnapshot,
} from '@shared/schemas';
import { isPlainObject } from '@shared/utils/string';
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
  toolCallCount: z.int().nonnegative().prefault(0),
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

export class WorkPlanState {
  private _todos: TodoItem[] = [];
  private _plan: Plan | null = null;
  private _planSummary: string | null = null;
  private _onTodosUpdate?: (todos: TodoItem[]) => void;
  private _onPlanUpdate?: (plan: Plan | null) => void;

  static fromSnapshot(snapshot: unknown): WorkPlanState {
    const parsed = WorkPlanSnapshotSchema.parse(snapshot);
    const state = new WorkPlanState();
    state._todos = [...parsed.todos];
    state._plan = parsed.plan;
    state._planSummary = parsed.planSummary;
    return state;
  }

  toSnapshot(): WorkPlanSnapshot {
    return WorkPlanSnapshotSchema.parse({
      todos: [...this._todos],
      plan: this._plan
        ? {
            ...this._plan,
            steps: this._plan.steps.map((s) => ({ ...s, files: [...s.files] })),
          }
        : null,
      planSummary: this._plan?.summary ?? this._planSummary,
    });
  }

  get todos(): TodoItem[] {
    return this._todos;
  }

  get plan(): Plan | null {
    return this._plan;
  }

  get planSummary(): string | null {
    return this._plan?.summary ?? this._planSummary;
  }

  setOnUpdate(callbacks: {
    onTodosUpdate?: (todos: TodoItem[]) => void;
    onPlanUpdate?: (plan: Plan | null) => void;
  }): void {
    this._onTodosUpdate = callbacks.onTodosUpdate;
    this._onPlanUpdate = callbacks.onPlanUpdate;
  }

  clearOnUpdate(): void {
    this._onTodosUpdate = undefined;
    this._onPlanUpdate = undefined;
  }

  updateTodos(todos: TodoItem[]): void {
    if (this._todosEqual(this._todos, todos)) return;
    this._todos = todos;
    this._onTodosUpdate?.(todos);
  }

  updatePlan(plan: Plan | null): void {
    const nextPlanSummary = plan?.summary ?? null;
    if (
      this._planEqual(this._plan, plan) &&
      this._planSummary === nextPlanSummary
    ) {
      return;
    }
    this._plan = plan;
    this._planSummary = nextPlanSummary;
    this._onPlanUpdate?.(plan);
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
        ai.activeForm !== bi.activeForm
      ) {
        return false;
      }
    }
    return true;
  }

  private _planEqual(a: Plan | null, b: Plan | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.summary !== b.summary) return false;
    if (a.steps.length !== b.steps.length) return false;
    for (let i = 0; i < a.steps.length; i++) {
      const ai = a.steps[i],
        bi = b.steps[i];
      if (!ai || !bi) return false;
      if (
        ai.title !== bi.title ||
        ai.description !== bi.description ||
        ai.status !== bi.status ||
        ai.files.length !== bi.files.length ||
        ai.files.some((f, j) => f !== bi.files[j])
      ) {
        return false;
      }
    }
    return true;
  }

  reset(): void {
    this._todos = [];
    this._plan = null;
    this._planSummary = null;
  }
}

function unwrapLegacyStateValue(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) return undefined;
  return value[key] ?? value;
}

function normalizeAgentWorkspaceSnapshot(input: unknown): unknown {
  const record = isPlainObject(input) ? input : {};
  const workPlan = record.workPlan ?? {
    todos: unwrapLegacyStateValue(record.todos, 'todos'),
    plan: unwrapLegacyStateValue(record.plan, 'plan'),
  };

  return {
    ...record,
    workPlan,
  };
}

export const AgentWorkspaceStateSnapshotSchema = z.preprocess(
  normalizeAgentWorkspaceSnapshot,
  z.object({
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
    workPlan: WorkPlanSnapshotSchema.prefault({}),
  }),
);

export type AgentWorkspaceSnapshot = z.output<
  typeof AgentWorkspaceStateSnapshotSchema
>;

export class AgentWorkspaceState {
  public readonly assembly: ResponseAssemblyState;
  public readonly media: MediaAttachmentState;
  public readonly reasoning: ReasoningCacheState;
  public readonly interactions: FileInteractionState;
  public readonly serverToolContent: ServerToolContentState;
  public readonly workPlan: WorkPlanState;

  private constructor(
    assembly: ResponseAssemblyState,
    media: MediaAttachmentState,
    reasoning: ReasoningCacheState,
    interactions: FileInteractionState,
    serverToolContent: ServerToolContentState,
    workPlan: WorkPlanState,
  ) {
    this.assembly = assembly;
    this.media = media;
    this.reasoning = reasoning;
    this.interactions = interactions;
    this.serverToolContent = serverToolContent;
    this.workPlan = workPlan;
  }

  static create(): AgentWorkspaceState {
    return new AgentWorkspaceState(
      ResponseAssemblyStateSchema.parse({}),
      new MediaAttachmentState(),
      ReasoningCacheStateSchema.parse({}),
      new FileInteractionState(),
      ServerToolContentStateSchema.parse({}),
      new WorkPlanState(),
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
      WorkPlanState.fromSnapshot(parsed.workPlan),
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
      workPlan: this.workPlan.toSnapshot(),
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
