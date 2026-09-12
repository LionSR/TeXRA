import { z } from 'zod';

import type { ServerToolContentBlock } from '@agent/types/ServerTools';
import {
  AgentWorkspaceStateSnapshotSchema,
  planSummaryLine,
  type AgentWorkspaceSnapshot,
  type EditRecord,
  type FileLocation,
  type LineChanges,
  type Plan,
  type TodoItem,
  type WorkPlanSnapshot,
  WorkPlanSnapshotSchema,
} from '@shared/schemas';

/**
 * The persisted slices, read off the one snapshot schema (`@shared/schemas`).
 * `.unwrap()` drops the composition's `.prefault({})`: the whole snapshot
 * substitutes a missing slice, a slice parsed on its own still refuses
 * `undefined`.
 */
const ResponseAssemblyStateSchema =
  AgentWorkspaceStateSnapshotSchema.shape.assembly.unwrap();
type ResponseAssemblyState = z.output<typeof ResponseAssemblyStateSchema>;
const FileInteractionStateSnapshotSchema =
  AgentWorkspaceStateSnapshotSchema.shape.interactions.unwrap();
type FileInteractionStateSnapshot = z.output<
  typeof FileInteractionStateSnapshotSchema
>;
const MediaAttachmentStateSnapshotSchema =
  AgentWorkspaceStateSnapshotSchema.shape.media.unwrap();
type MediaAttachmentStateSnapshot = z.output<
  typeof MediaAttachmentStateSnapshotSchema
>;
const ReasoningCacheStateSchema =
  AgentWorkspaceStateSnapshotSchema.shape.reasoning.unwrap();
type ReasoningCacheState = z.output<typeof ReasoningCacheStateSchema>;

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

  recordEdits(edits: EditRecord[] | undefined): string[] {
    if (!Array.isArray(edits)) {
      return [];
    }

    const touchedPaths = new Set<string>();

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
    }

    return [...touchedPaths];
  }
}

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

/**
 * Server-tool content carried across turns. Never persisted — every
 * `AgentWorkspaceState` starts it empty — so it is a plain in-memory struct
 * rather than a parse boundary.
 */
interface ServerToolContentState {
  contentBlocks: ServerToolContentBlock[];
  lastAssistantContent: unknown[];
}

function emptyServerToolContent(): ServerToolContentState {
  return { contentBlocks: [], lastAssistantContent: [] };
}

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
      emptyServerToolContent(),
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
   * Hydration: validates the snapshot, then rebuilds the slices. The one entry
   * point for every caller, because there is one supported persisted format.
   *
   * A persisted snapshot hydrates where a loop reads it off the run's latest
   * `flow.snapshot` (`@agent/runtime/loop/toolUse`, `@agent/runtime/loop/reflection`);
   * a loop re-deriving state from `toSnapshot()` output produced this run
   * runs the same parse.
   */
  static fromSnapshot(snapshot: unknown): AgentWorkspaceState {
    const parsed = AgentWorkspaceStateSnapshotSchema.parse(snapshot);
    return new AgentWorkspaceState(
      parsed.assembly,
      MediaAttachmentState.fromSnapshot(parsed.media),
      parsed.reasoning,
      FileInteractionState.fromSnapshot(parsed.interactions),
      emptyServerToolContent(),
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
