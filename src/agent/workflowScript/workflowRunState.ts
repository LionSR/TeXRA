import {
  RUN_OUTCOME,
  WORKFLOW_CALL_STATUS,
  isTerminalWorkflowCallStatus,
  type RunId,
  type RunOutcome,
  type WorkflowCallIdentity,
  type WorkflowCallKind,
  type WorkflowCallProgress,
  type WorkflowCallStatus,
} from '@shared/schemas';
import { WORKFLOW_CALL_UNFINISHED_NOTE } from '@shared/copy/workflowCall';

import type { WorkflowAttemptFacts, WorkflowScriptEvent } from './types';

type WorkflowCallFiles = NonNullable<WorkflowCallProgress['files']>;

interface WorkflowCallDefinition {
  readonly id: string;
  readonly label: string;
  readonly phase?: string;
  readonly kind: WorkflowCallKind;
  readonly agent?: string;
  /** Model the script declared for this call; the host may still substitute. */
  readonly model?: string;
  readonly files: WorkflowCallFiles;
}

/** One call as the engine tracks it: a plan label until issued, then the
 *  invocation facts and the attempt history the card is cut from. */
interface WorkflowCallRecord {
  readonly id: string;
  readonly label: string;
  readonly phase?: string;
  /** Invocation facts, present once the script issued the call. */
  kind?: WorkflowCallKind;
  agent?: string;
  model?: string;
  files?: WorkflowCallFiles;
  childRunId?: RunId;
  status: WorkflowCallStatus;
  /** Physical attempts begun; one cost slot per attempt, filled by report. */
  attempts: number;
  attemptCosts: (number | undefined)[];
  /** First attempt's start; a retry keeps it so duration spans every attempt. */
  startedAtMs?: number;
  error?: string;
}

interface WorkflowStageRecord {
  readonly title: string;
  entered: boolean;
  closed: boolean;
}

/**
 * The engine's contract authority over stages and calls: it enforces the
 * plan (declared stages, monotonic entry, issue-once, stage membership) and
 * publishes every transition once as a {@link WorkflowScriptEvent}. It keeps
 * no snapshot for anyone to read; the event stream is the run's account.
 */
export class WorkflowRunState {
  readonly #emit: (event: WorkflowScriptEvent) => void;
  readonly #hasDeclaredStages: boolean;
  readonly #declaredStageCount: number;
  readonly #stages: WorkflowStageRecord[];
  readonly #calls = new Map<string, WorkflowCallRecord>();
  readonly #issuedCallIds = new Set<string>();
  #currentIndex = -1;
  #sealed = false;

  constructor(options: {
    readonly phases: readonly { readonly title: string }[];
    readonly tasks: readonly WorkflowCallIdentity[];
    readonly emit: (event: WorkflowScriptEvent) => void;
  }) {
    this.#emit = options.emit;
    this.#hasDeclaredStages = options.phases.length > 0;
    this.#declaredStageCount = options.phases.length;
    this.#stages = options.phases.map((phase) => ({
      title: phase.title,
      entered: false,
      closed: false,
    }));
    for (const task of options.tasks) {
      this.#calls.set(task.id, {
        id: task.id,
        label: task.label,
        ...(task.phase !== undefined && { phase: task.phase }),
        status: WORKFLOW_CALL_STATUS.DECLARED,
        attempts: 0,
        attemptCosts: [],
      });
    }
    this.#emit({
      type: 'plan',
      plan: {
        phases: options.phases.map((phase) => ({ title: phase.title })),
        tasks: options.tasks.map((task) => ({
          id: task.id,
          label: task.label,
          ...(task.phase !== undefined && { phase: task.phase }),
        })),
      },
    });
    // A plan label behind a stage gate waits for `phase()` to open it; one
    // declared outside any stage has no gate and shows at once.
    for (const call of this.#calls.values()) {
      if (call.phase === undefined) this.#emitCard(call);
    }
  }

  get currentPhase(): string | undefined {
    return this.#stages[this.#currentIndex]?.title;
  }

  get currentPhaseIndex(): number {
    return this.#currentIndex;
  }

  /** True once `finish` ran: every later transition is a no-op. */
  get sealed(): boolean {
    return this.#sealed;
  }

  enterStage(title: string): void {
    if (this.#sealed) throw new Error('Workflow run state is sealed.');
    let nextIndex = this.#stages.findIndex((stage) => stage.title === title);
    if (nextIndex < 0 && this.#hasDeclaredStages) {
      throw new Error(`phase() references undeclared stage "${title}".`);
    }
    if (nextIndex < 0) {
      nextIndex = this.#stages.length;
      this.#stages.push({ title, entered: false, closed: false });
    }
    if (nextIndex < this.#currentIndex) {
      throw new Error(
        `Workflow stages must advance monotonically; cannot enter "${title}" after ${this.currentPhase ?? 'the same stage'}.`,
      );
    }
    if (nextIndex === this.#currentIndex) return;

    const stage = this.#stages[nextIndex];
    stage.entered = true;
    this.#currentIndex = nextIndex;
    this.#emit({
      type: 'phase.open',
      title,
      index: nextIndex,
      ...(nextIndex < this.#declaredStageCount && {
        total: this.#declaredStageCount,
      }),
    });
    for (const call of this.#calls.values()) {
      if (call.phase === title && call.status === WORKFLOW_CALL_STATUS.DECLARED)
        this.#emitCard(call);
    }
    this.#closeSettledStages();
  }

  issueCall(definition: WorkflowCallDefinition): void {
    if (this.#sealed) throw new Error('Workflow run state is sealed.');
    if (this.#issuedCallIds.has(definition.id)) {
      throw new Error(
        `Workflow call id "${definition.id}" may be issued only once per run.`,
      );
    }
    this.#issuedCallIds.add(definition.id);
    const stageIndex =
      definition.phase === undefined
        ? -1
        : this.#stages.findIndex((stage) => stage.title === definition.phase);
    if (definition.phase !== undefined && stageIndex < 0) {
      throw new Error(
        `agent() references stage "${definition.phase}" before phase() entered it.`,
      );
    }
    if (definition.phase !== undefined && stageIndex !== this.#currentIndex) {
      throw new Error(
        `agent() task ${definition.id} belongs to stage "${definition.phase}", but the current stage is ${this.currentPhase ?? 'not set'}.`,
      );
    }
    const call: WorkflowCallRecord = {
      id: definition.id,
      label: definition.label,
      ...(definition.phase !== undefined && { phase: definition.phase }),
      kind: definition.kind,
      ...(definition.agent !== undefined && { agent: definition.agent }),
      ...(definition.model !== undefined && { model: definition.model }),
      files: definition.files,
      status: WORKFLOW_CALL_STATUS.QUEUED,
      attempts: 0,
      attemptCosts: [],
    };
    this.#calls.set(definition.id, call);
    this.#emitCard(call);
  }

  #call(id: string): WorkflowCallRecord {
    const call = this.#calls.get(id);
    if (!call) throw new Error(`Workflow call ${id} is missing.`);
    return call;
  }

  /**
   * Re-queue a live call for a fresh attempt after an interactive retry. The
   * previous attempt's resolved facts are dropped — a stale child run or
   * model must not describe the attempt about to start — while the model the
   * script itself declared stays visible until the host reports what it
   * resolved. The logical start is kept so duration covers every attempt.
   */
  queueCall(id: string, declared: { readonly model?: string } = {}): void {
    if (this.#sealed) return;
    const call = this.#call(id);
    const changed = call.status !== WORKFLOW_CALL_STATUS.QUEUED;
    call.status = WORKFLOW_CALL_STATUS.QUEUED;
    call.childRunId = undefined;
    call.model = declared.model;
    call.error = undefined;
    if (changed) this.#emitCard(call);
  }

  beginAttempt(id: string): void {
    if (this.#sealed) return;
    const call = this.#call(id);
    call.attempts += 1;
    call.attemptCosts.push(undefined);
    call.startedAtMs ??= Date.now();
    call.status = WORKFLOW_CALL_STATUS.RUNNING;
    this.#emitCard(call);
  }

  /**
   * Stamp host-resolved facts onto the call's latest attempt. Each fact is
   * independent — an omitted one leaves the current value in place — and the
   * card is re-sent only when something it shows changed: a cost-only
   * report is accounting, not a transition.
   */
  reportAttempt(
    id: string,
    facts: Omit<WorkflowAttemptFacts, 'recovered'>,
  ): void {
    if (this.#sealed) return;
    const call = this.#call(id);
    let changed = false;
    if (
      facts.childRunId !== undefined &&
      facts.childRunId !== call.childRunId
    ) {
      call.childRunId = facts.childRunId;
      changed = true;
    }
    if (facts.model !== undefined && facts.model !== call.model) {
      call.model = facts.model;
      changed = true;
    }
    if (facts.agent !== undefined && facts.agent !== call.agent) {
      call.agent = facts.agent;
      changed = true;
    }
    if (facts.costUsd !== undefined && call.attemptCosts.length > 0) {
      call.attemptCosts[call.attemptCosts.length - 1] = facts.costUsd;
    }
    if (changed) this.#emitCard(call);
  }

  /** Terminalize one call: the caller owns the status (and error). */
  settleCall(
    id: string,
    patch:
      | {
          readonly status: typeof WORKFLOW_CALL_STATUS.FAILED;
          readonly error: string;
        }
      | {
          readonly status:
            | typeof WORKFLOW_CALL_STATUS.CACHED
            | typeof WORKFLOW_CALL_STATUS.CANCELLED
            | typeof WORKFLOW_CALL_STATUS.COMPLETED
            | typeof WORKFLOW_CALL_STATUS.SKIPPED;
        },
  ): void {
    if (this.#sealed) return;
    const call = this.#call(id);
    call.status = patch.status;
    call.error =
      patch.status === WORKFLOW_CALL_STATUS.FAILED ? patch.error : undefined;
    this.#emitCard(call);
    this.#closeSettledStages();
  }

  /**
   * The terminal sweep: a plan label the run never issued is skipped as
   * not-reached; a call still queued or running is cancelled with the run or
   * failed with its error (the unfinished note when the run ended without
   * one). Then every stage the run reached, or that owns a card, closes.
   */
  finish(outcome: RunOutcome, error?: string): void {
    if (this.#sealed) return;
    for (const call of this.#calls.values()) {
      if (call.status === WORKFLOW_CALL_STATUS.DECLARED) {
        call.status = WORKFLOW_CALL_STATUS.SKIPPED;
        this.#emit({
          type: 'call',
          call: {
            ...this.#identity(call),
            status: 'skipped',
            reason: 'not-reached',
          },
        });
      } else if (
        call.status === WORKFLOW_CALL_STATUS.QUEUED ||
        call.status === WORKFLOW_CALL_STATUS.RUNNING
      ) {
        // A swept call never reached its own settlement: its card carries
        // spend but no duration.
        const costUsd = totalAttemptCost(call.attemptCosts);
        const spent = costUsd !== undefined ? { costUsd } : {};
        if (outcome === RUN_OUTCOME.CANCELLED) {
          call.status = WORKFLOW_CALL_STATUS.CANCELLED;
          this.#emit({
            type: 'call',
            call: { ...this.#identity(call), status: 'cancelled', ...spent },
          });
        } else {
          call.status = WORKFLOW_CALL_STATUS.FAILED;
          call.error = error ?? WORKFLOW_CALL_UNFINISHED_NOTE;
          this.#emit({
            type: 'call',
            call: {
              ...this.#identity(call),
              status: 'failed',
              error: call.error,
              ...spent,
            },
          });
        }
      }
    }
    this.#currentIndex = -1;
    this.#closeSettledStages(outcome);
    this.#sealed = true;
  }

  /**
   * Close every stage the script has left whose calls have all settled, so a
   * finished phase reads finished while later phases still run and a failure
   * in phase 3 cannot retroactively mark phases 1–2. Worst wins: one failed
   * call fails the stage, one cancelled call cancels it. A reached stage the
   * sweep settled outright has no call of its own to read, so the run's
   * outcome is its outcome; a stage that issued nothing at all completed.
   */
  #closeSettledStages(runOutcome?: RunOutcome): void {
    for (const [index, stage] of this.#stages.entries()) {
      if (stage.closed || index === this.#currentIndex) continue;
      const calls = [...this.#calls.values()].filter(
        (call) => call.phase === stage.title,
      );
      // A stage never entered closes only with the run, for the not-reached
      // cards it owns; without any it was never announced.
      if (!stage.entered && (runOutcome === undefined || calls.length === 0))
        continue;
      if (!calls.every((call) => isTerminalWorkflowCallStatus(call.status)))
        continue;
      const issued = calls.filter((call) => call.kind !== undefined);
      let outcome: RunOutcome =
        calls.length > 0 && issued.length === 0
          ? (runOutcome ?? RUN_OUTCOME.COMPLETED)
          : RUN_OUTCOME.COMPLETED;
      if (issued.some((call) => call.status === WORKFLOW_CALL_STATUS.CANCELLED))
        outcome = RUN_OUTCOME.CANCELLED;
      if (issued.some((call) => call.status === WORKFLOW_CALL_STATUS.FAILED))
        outcome = RUN_OUTCOME.FAILED;
      stage.closed = true;
      this.#emit({ type: 'phase.close', title: stage.title, outcome });
    }
  }

  /** The facts every card carries; invocation facts only once issued. */
  #identity(call: WorkflowCallRecord) {
    const attemptCounts =
      call.attempts > 1 &&
      (call.status === WORKFLOW_CALL_STATUS.RUNNING ||
        call.status === WORKFLOW_CALL_STATUS.COMPLETED ||
        call.status === WORKFLOW_CALL_STATUS.FAILED ||
        call.status === WORKFLOW_CALL_STATUS.CANCELLED ||
        (call.status === WORKFLOW_CALL_STATUS.SKIPPED &&
          call.kind !== undefined));
    return {
      id: call.id,
      label: call.label,
      ...(call.phase !== undefined && { phase: call.phase }),
      ...(call.childRunId !== undefined && { childRunId: call.childRunId }),
      ...(call.kind !== undefined && { kind: call.kind }),
      ...(call.agent !== undefined && { agent: call.agent }),
      ...(call.model !== undefined && { model: call.model }),
      ...(call.files !== undefined && { files: call.files }),
      ...(attemptCounts && { attemptNumber: call.attempts }),
    };
  }

  #emitCard(call: WorkflowCallRecord): void {
    this.#emit({ type: 'call', call: this.#cardFor(call) });
  }

  #cardFor(call: WorkflowCallRecord): WorkflowCallProgress {
    const identity = this.#identity(call);
    switch (call.status) {
      case WORKFLOW_CALL_STATUS.DECLARED:
      case WORKFLOW_CALL_STATUS.QUEUED:
      case WORKFLOW_CALL_STATUS.RUNNING:
      case WORKFLOW_CALL_STATUS.CACHED:
        return { ...identity, status: call.status };
      case WORKFLOW_CALL_STATUS.COMPLETED:
      case WORKFLOW_CALL_STATUS.CANCELLED:
        return { ...identity, status: call.status, ...terminalMetadata(call) };
      case WORKFLOW_CALL_STATUS.SKIPPED:
        return {
          ...identity,
          status: 'skipped',
          reason: 'user',
          ...terminalMetadata(call),
        };
      case WORKFLOW_CALL_STATUS.FAILED:
        if (call.error === undefined) {
          throw new Error(`Failed workflow call ${call.id} carries no error.`);
        }
        return {
          ...identity,
          status: 'failed',
          error: call.error,
          ...terminalMetadata(call),
        };
    }
  }
}

/** Duration and spend of a call that settled through its own path. */
function terminalMetadata(call: WorkflowCallRecord): {
  readonly durationMs?: number;
  readonly costUsd?: number;
} {
  const costUsd = totalAttemptCost(call.attemptCosts);
  return {
    ...(call.startedAtMs !== undefined && {
      durationMs: Math.max(0, Date.now() - call.startedAtMs),
    }),
    ...(costUsd !== undefined && { costUsd }),
  };
}

function totalAttemptCost(
  attemptCosts: readonly (number | undefined)[],
): number | undefined {
  return attemptCosts.some((cost) => cost !== undefined)
    ? attemptCosts.reduce<number>((total, cost) => total + (cost ?? 0), 0)
    : undefined;
}
