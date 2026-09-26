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
} from '@shared/schemas';

export class FileInteractionState {
  private readonly readFiles: Set<string>;
  private readonly edits: Map<string, LineChanges>;
  private _toolCallCount: number;

  /** Fresh, or rehydrated from the slice `AgentWorkspaceState` parsed. */
  constructor(snapshot?: AgentWorkspaceSnapshot['interactions']) {
    this.readFiles = new Set(snapshot?.readFiles);
    this.edits = new Map(
      snapshot?.edits.map(({ path, added, removed }) => [
        path,
        { added, removed },
      ]),
    );
    this._toolCallCount = snapshot?.toolCallCount ?? 0;
  }

  /** Total number of tool calls executed in this session. */
  get toolCallCount(): number {
    return this._toolCallCount;
  }

  toSnapshot(): AgentWorkspaceSnapshot['interactions'] {
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

      const totals = this.edits.get(path) ?? { added: 0, removed: 0 };
      totals.added += added;
      totals.removed += removed;
      this.edits.set(path, totals);
      touchedPaths.add(path);
    }

    return [...touchedPaths];
  }
}

class MediaAttachmentState {
  private readonly _files: FileLocation[] = [];
  private readonly pathSet = new Set<string>();

  /** Fresh, or rehydrated from the slice `AgentWorkspaceState` parsed. */
  constructor(snapshot?: AgentWorkspaceSnapshot['media']) {
    this.addMediaFiles(snapshot?.files ?? []);
  }

  /**
   * Attached media in insertion order. Read-only: `addMediaFiles` is the only
   * way in, because it also maintains the path-deduplication set.
   */
  get files(): readonly FileLocation[] {
    return this._files;
  }

  toSnapshot(): AgentWorkspaceSnapshot['media'] {
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

export class WorkPlanState {
  private _todos: TodoItem[];
  private _plan: Plan | null;
  private _onTodosUpdate?: (todos: TodoItem[]) => void;
  private _onPlanUpdate?: (plan: Plan | null) => void;

  /** Fresh, or rehydrated from the slice `AgentWorkspaceState` parsed. */
  constructor(snapshot?: WorkPlanSnapshot) {
    this._todos = [...(snapshot?.todos ?? [])];
    this._plan = snapshot?.plan ?? null;
  }

  toSnapshot(): WorkPlanSnapshot {
    return {
      todos: [...this._todos],
      plan: this._plan ? { ...this._plan } : null,
      planSummary: this._plan ? planSummaryLine(this._plan.objective) : null,
    };
  }

  get todos(): TodoItem[] {
    return this._todos;
  }

  get plan(): Plan | null {
    return this._plan;
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
    if (this._planEqual(this._plan, plan)) return;
    this._plan = plan;
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
    public readonly assembly: AgentWorkspaceSnapshot['assembly'],
    public readonly media: MediaAttachmentState,
    public readonly reasoning: AgentWorkspaceSnapshot['reasoning'],
    public readonly interactions: FileInteractionState,
    public readonly workPlan: WorkPlanState,
  ) {}

  /** A run's starting state: the canonical empty snapshot, hydrated. */
  static create(): AgentWorkspaceState {
    return AgentWorkspaceState.fromSnapshot({ workPlan: {} });
  }

  /**
   * Create an empty snapshot without instantiating a full class.
   * Use at initialization sites that only need the serializable shape.
   */
  static emptySnapshot(): AgentWorkspaceSnapshot {
    return AgentWorkspaceStateSnapshotSchema.parse({ workPlan: {} });
  }

  /**
   * Hydration: validates the snapshot, then rebuilds the slices. The one entry
   * point for every caller, because there is one supported persisted format.
   *
   * A persisted snapshot hydrates where a loop reads it off the run's latest
   * `flow.snapshot` (`@agent/runtime/loop/toolUse`);
   * a loop re-deriving state from `toSnapshot()` output produced this run
   * runs the same parse.
   */
  static fromSnapshot(snapshot: unknown): AgentWorkspaceState {
    const parsed = AgentWorkspaceStateSnapshotSchema.parse(snapshot);
    return new AgentWorkspaceState(
      parsed.assembly,
      new MediaAttachmentState(parsed.media),
      parsed.reasoning,
      new FileInteractionState(parsed.interactions),
      new WorkPlanState(parsed.workPlan),
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
}
