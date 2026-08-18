import { z } from 'zod';

import type { ServerToolContentBlock } from '@agent/types/ServerTools';
import {
  FileLocationSchema,
  LineCountSchema,
  planSummaryLine,
  type EditRecord,
  type FileLocation,
  type LineChanges,
  type Plan,
  type TodoItem,
  type WorkPlanSnapshot,
  WorkPlanSnapshotSchema,
} from '@shared/schemas';
import { pathToLocation } from '@utils/files/fileLocation';

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

/** File-local snapshot schema for flattened file-edit records. */
const FileEditSnapshotSchema = z.object({
  path: z.string(),
  added: LineCountSchema.prefault(0),
  removed: LineCountSchema.prefault(0),
});

/** Internal schema for file interaction state snapshot. */
const FileInteractionStateSnapshotSchema = z.object({
  readFiles: z.array(z.string()).prefault([]),
  edits: z.array(FileEditSnapshotSchema).prefault([]),
  toolCallCount: z.int().nonnegative().prefault(0),
});

type FileInteractionStateSnapshot = z.output<
  typeof FileInteractionStateSnapshotSchema
>;

export class FileInteractionState {
  private readonly readFiles = new Set<string>();
  private readonly edits = new Map<string, LineChanges>();
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

  recordEdits(edits: EditRecord[] | undefined): {
    paths: string[];
    lineChanges?: LineChanges;
  } {
    if (!Array.isArray(edits)) {
      return { paths: [] };
    }

    const touchedPaths = new Set<string>();
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const entry of edits) {
      const path = entry?.path;
      if (!path) continue;

      const added = entry.lineChanges?.added ?? 0;
      const removed = entry.lineChanges?.removed ?? 0;

      const existing = this.edits.get(path);
      if (existing) {
        existing.added += added;
        existing.removed += removed;
      } else {
        this.edits.set(path, { added, removed });
      }
      touchedPaths.add(path);

      totalAdded += added;
      totalRemoved += removed;
    }

    return {
      paths: [...touchedPaths],
      lineChanges:
        totalAdded || totalRemoved
          ? { added: totalAdded, removed: totalRemoved }
          : undefined,
    };
  }
}

const MediaFileEntrySchema = z
  .union([z.string(), FileLocationSchema])
  .transform((entry): FileLocation =>
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
  private readonly _files: FileLocation[] = [];
  private readonly pathSet = new Set<string>();

  static fromSnapshot(snapshot: unknown): MediaAttachmentState {
    const parsed = MediaAttachmentStateSnapshotSchema.parse(snapshot);
    const state = new MediaAttachmentState();
    state.addMediaFiles(parsed.files);
    return state;
  }

  /**
   * Attached media in insertion order. Read-only: `addMediaFiles` is the only
   * way in, because it also maintains the path-deduplication set.
   */
  get files(): readonly FileLocation[] {
    return this._files;
  }

  toSnapshot(): MediaAttachmentStateSnapshot {
    return { files: [...this._files] };
  }

  addMediaFiles(locations: readonly FileLocation[]): void {
    for (const location of locations) {
      if (!this.pathSet.has(location.absolutePath)) {
        this.pathSet.add(location.absolutePath);
        this._files.push(location);
      }
    }
  }
}

/** Internal schema for reasoning cache state. */
const ReasoningCacheStateSchema = z.object({
  thinkingBlocks: z.array(ThinkingBlockSchema).prefault([]),
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
      plan: this._plan ? { ...this._plan } : null,
      planSummary: this._planSummary,
    });
  }

  get todos(): TodoItem[] {
    return this._todos;
  }

  get plan(): Plan | null {
    return this._plan;
  }

  get planSummary(): string | null {
    return this._planSummary;
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
    const nextPlanSummary = plan ? planSummaryLine(plan.objective) : null;
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
    return (
      a.length === b.length &&
      a.every((ai, i) => {
        const bi = b[i];
        if (!ai || !bi) return false;
        return (
          ai.content === bi.content &&
          ai.status === bi.status &&
          ai.activeForm === bi.activeForm
        );
      })
    );
  }

  private _planEqual(a: Plan | null, b: Plan | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.objective === b.objective;
  }
}

const AgentWorkspaceSnapshotFieldsSchema = z.object({
  assembly: ResponseAssemblyStateSchema.prefault({}),
  media: MediaAttachmentStateSnapshotSchema.prefault({}),
  reasoning: ReasoningCacheStateSchema.prefault({}),
  interactions: FileInteractionStateSnapshotSchema.prefault({}),
  workPlan: WorkPlanSnapshotSchema,
});

/**
 * Canonical shape of an `AgentWorkspaceState` snapshot. Persisted workspace
 * state has one supported format; an older record fails its resume parse.
 */
export const AgentWorkspaceStateSnapshotSchema = z
  .looseObject({ workPlan: z.unknown() })
  .refine(
    (record) => Object.hasOwn(record, 'workPlan') && record.workPlan != null,
  )
  .transform((record) => AgentWorkspaceSnapshotFieldsSchema.parse(record));

export type AgentWorkspaceSnapshot = z.output<
  typeof AgentWorkspaceStateSnapshotSchema
>;

export class AgentWorkspaceState {
  private constructor(
    public readonly assembly: ResponseAssemblyState,
    public readonly media: MediaAttachmentState,
    public readonly reasoning: ReasoningCacheState,
    public readonly interactions: FileInteractionState,
    public readonly serverToolContent: ServerToolContentState,
    public readonly workPlan: WorkPlanState,
  ) {}

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
    return AgentWorkspaceStateSnapshotSchema.parse({ workPlan: {} });
  }

  /**
   * Boundary hydration: validates an untrusted persisted snapshot. Call this
   * exactly once, where a persisted snapshot first hydrates into a session
   * (session-init resume in `ToolUsePrepareNode`, a reflection flow's resume
   * read in `runReflectionFlow`, or `runToolUseFlow`'s tool-use resume boundary
   * normalizing the nested `stateSlices.workspaceSnapshot` it self-heals into
   * the resumed flow record — needed because a resume whose persisted cursor is
   * already past `ToolUsePrepareNode` never runs that node's own hydration).
   * Everywhere else — per-round node prep re-deriving state from `toSnapshot()`
   * output already produced this run — use `fromCanonicalSnapshot` instead.
   */
  static fromSnapshot(snapshot: unknown): AgentWorkspaceState {
    const parsed = AgentWorkspaceStateSnapshotSchema.parse(snapshot);
    return AgentWorkspaceState.fromParsedFields(parsed);
  }

  /**
   * Rebuild from a snapshot already known to be canonical (e.g. round-tripped
   * through this class's own `toSnapshot()`). Validates the canonical shape so
   * repeated per-round calls (tool-use `ToolUseCycleNode`, reflection
   * `ResponseCycleNode`/`MediaExtractionNode`) have the same validation path.
   */
  static fromCanonicalSnapshot(
    snapshot: AgentWorkspaceSnapshot,
  ): AgentWorkspaceState {
    const parsed = AgentWorkspaceStateSnapshotSchema.parse(snapshot);
    return AgentWorkspaceState.fromParsedFields(parsed);
  }

  private static fromParsedFields(
    parsed: AgentWorkspaceSnapshot,
  ): AgentWorkspaceState {
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
  }

  resetServerToolContent(): void {
    this.serverToolContent.contentBlocks = [];
    this.serverToolContent.lastAssistantContent = [];
  }
}
