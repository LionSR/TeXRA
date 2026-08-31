import {
  TERMINAL_WORKFLOW_CALL_STATUSES,
  WORKFLOW_CALL_STATUS,
  WORKFLOW_EXECUTION_LIFECYCLE,
  type WorkflowCallIdentity,
  type WorkflowCallKind,
  type WorkflowExecutionCall,
  type WorkflowExecutionSnapshot,
} from '@shared/schemas';
import { WORKFLOW_CALL_UNFINISHED_NOTE } from '@shared/copy/workflowCall';

import type { WorkflowAttemptFacts } from './types';

type KeysOfUnion<T> = T extends T ? keyof T : never;
type ValueOfUnion<T, K extends PropertyKey> = T extends T
  ? K extends keyof T
    ? T[K]
    : never
  : never;
type WorkflowExecutionCallPatch = {
  [K in KeysOfUnion<WorkflowExecutionCall>]?: ValueOfUnion<
    WorkflowExecutionCall,
    K
  >;
};

interface WorkflowCallDefinition {
  readonly id: string;
  readonly label: string;
  readonly phase?: string;
  readonly kind: WorkflowCallKind;
  readonly agent?: string;
  /** Model the script declared for this call; the host may still substitute. */
  readonly model?: string;
  readonly files: WorkflowExecutionCall['files'];
}

/** Owns canonical workflow stage/call transitions and interrupted-run hydration. */
export class WorkflowExecutionState {
  readonly #snapshot: WorkflowExecutionSnapshot;
  readonly #publish: (snapshot: WorkflowExecutionSnapshot) => void;
  readonly #hasDeclaredStages: boolean;
  readonly #issuedCallIds = new Set<string>();
  #sealed = false;

  constructor(options: {
    readonly phases: readonly { readonly title: string }[];
    readonly tasks: readonly WorkflowCallIdentity[];
    readonly initialSnapshot?: WorkflowExecutionSnapshot;
    /**
     * Receives the live snapshot on every transition, not a copy. Consumers
     * that retain it or persist asynchronously must clone it first (the
     * runner's snapshot writer clones at drain time).
     */
    readonly publish: (snapshot: WorkflowExecutionSnapshot) => void;
  }) {
    this.#publish = options.publish;
    this.#hasDeclaredStages = options.phases.length > 0;
    const createdAt = now();
    const fresh: WorkflowExecutionSnapshot = {
      lifecycle: WORKFLOW_EXECUTION_LIFECYCLE.WAITING,
      stages: options.phases.map((phase, index) => ({
        id: stageIdFor(index),
        title: phase.title,
        order: index,
        lifecycle: WORKFLOW_EXECUTION_LIFECYCLE.WAITING,
      })),
      calls: options.tasks.map((task) => {
        const timestamp = now();
        const stageIndex = options.phases.findIndex(
          (phase) => phase.title === task.phase,
        );
        return {
          id: task.id,
          label: task.label,
          ...(task.phase !== undefined && {
            stageId: stageIdFor(stageIndex),
          }),
          files: { input: [], context: [], media: [] },
          attempts: [],
          status:
            task.phase === undefined
              ? WORKFLOW_CALL_STATUS.PLANNED
              : WORKFLOW_CALL_STATUS.STAGE_BLOCKED,
          timestamps: { createdAt: timestamp, updatedAt: timestamp },
        };
      }),
      timestamps: { createdAt, updatedAt: createdAt },
    };
    this.#snapshot = hydrate(fresh, options.initialSnapshot, createdAt);
    this.#emit();
  }

  get currentPhase(): string | undefined {
    return this.#snapshot.stages[this.currentPhaseIndex]?.title;
  }

  get currentPhaseIndex(): number {
    return this.#snapshot.stages.findIndex(
      (stage) => stage.id === this.#snapshot.currentStageId,
    );
  }

  snapshot(): WorkflowExecutionSnapshot {
    return structuredClone(this.#snapshot);
  }

  enterStage(title: string): void {
    if (this.#sealed) throw new Error('Workflow execution state is sealed.');
    let nextIndex = this.#snapshot.stages.findIndex(
      (stage) => stage.title === title,
    );
    if (nextIndex < 0 && this.#hasDeclaredStages) {
      throw new Error(`phase() references undeclared stage "${title}".`);
    }
    if (nextIndex < 0) {
      nextIndex = this.#snapshot.stages.length;
      this.#snapshot.stages.push({
        id: stageIdFor(nextIndex),
        title,
        order: nextIndex,
        lifecycle: WORKFLOW_EXECUTION_LIFECYCLE.WAITING,
      });
    }
    const currentStageIndex = this.currentPhaseIndex;
    if (nextIndex < currentStageIndex) {
      throw new Error(
        `Workflow stages must advance monotonically; cannot enter "${title}" after ${this.currentPhase ?? 'the same stage'}.`,
      );
    }
    if (nextIndex === currentStageIndex) return;

    const transitionAt = now();
    const prior = this.#snapshot.stages[currentStageIndex];
    if (prior) this.#settleStage(prior.id, transitionAt);
    for (const stage of this.#snapshot.stages) {
      if (
        stage.order < nextIndex &&
        stage.lifecycle === WORKFLOW_EXECUTION_LIFECYCLE.WAITING
      ) {
        stage.lifecycle = WORKFLOW_EXECUTION_LIFECYCLE.SKIPPED;
        stage.completedAt = transitionAt;
      }
    }
    const active = this.#snapshot.stages[nextIndex];
    active.lifecycle = WORKFLOW_EXECUTION_LIFECYCLE.ACTIVE;
    active.startedAt ??= transitionAt;
    active.completedAt = undefined;
    this.#snapshot.currentStageId = active.id;
    this.#snapshot.lifecycle = WORKFLOW_EXECUTION_LIFECYCLE.ACTIVE;
    for (const [index, call] of this.#snapshot.calls.entries()) {
      if (
        call.stageId === active.id &&
        call.status === WORKFLOW_CALL_STATUS.STAGE_BLOCKED
      ) {
        this.#snapshot.calls[index] = {
          ...call,
          status: WORKFLOW_CALL_STATUS.PLANNED,
          timestamps: { ...call.timestamps, updatedAt: transitionAt },
        };
      }
    }
    this.#emit();
  }

  issueCall(definition: WorkflowCallDefinition): void {
    if (this.#sealed) throw new Error('Workflow execution state is sealed.');
    if (this.#issuedCallIds.has(definition.id)) {
      throw new Error(
        `Workflow call id "${definition.id}" may be issued only once per run.`,
      );
    }
    this.#issuedCallIds.add(definition.id);
    let call = this.#snapshot.calls.find(
      (candidate) => candidate.id === definition.id,
    );
    const stageIndex =
      definition.phase === undefined
        ? -1
        : this.#snapshot.stages.findIndex(
            (stage) => stage.title === definition.phase,
          );
    if (definition.phase !== undefined && stageIndex < 0) {
      throw new Error(
        `agent() references stage "${definition.phase}" before phase() entered it.`,
      );
    }
    if (
      definition.phase !== undefined &&
      stageIndex !== this.currentPhaseIndex
    ) {
      throw new Error(
        `agent() task ${definition.id} belongs to stage "${definition.phase}", but the current stage is ${this.currentPhase ?? 'not set'}.`,
      );
    }
    const timestamp = now();
    // Only assign agent when the call definition supplies one. Engine issue
    // often omits agentName; a later report fills the host-resolved name.
    // Re-issuing on resume must not wipe a hydrated agent with undefined —
    // the journal-cache path only patches status/timestamps and would leave
    // /executions without the resolved agent after a cached replay.
    const canonical = {
      label: definition.label,
      stageId: stageIndex < 0 ? undefined : stageIdFor(stageIndex),
      issued: true as const,
      kind: definition.kind,
      files: definition.files,
      ...(definition.agent !== undefined && { agent: definition.agent }),
      ...(definition.model !== undefined && { model: definition.model }),
    };
    if (!call) {
      call = {
        id: definition.id,
        ...canonical,
        attempts: [],
        status: WORKFLOW_CALL_STATUS.PLANNED,
        timestamps: { createdAt: timestamp, updatedAt: timestamp },
      };
      this.#snapshot.calls.push(call);
    } else {
      // A hydrated completed/cached result belongs to the prior attempt until
      // the script re-issues the call; from here it is this attempt's call —
      // replayed from the journal as cached, or re-run in a fresh execution
      // window — so every attempt projects it the same way.
      Object.assign(
        call,
        canonical,
        isReusableStatus(call.status) && {
          status: WORKFLOW_CALL_STATUS.PLANNED,
          timestamps: { createdAt: call.timestamps.createdAt },
        },
      );
      call.timestamps.updatedAt = timestamp;
    }
    this.#emit();
  }

  #call(id: string): WorkflowExecutionCall {
    const call = this.#snapshot.calls.find((candidate) => candidate.id === id);
    if (!call) throw new Error(`Workflow snapshot call ${id} is missing.`);
    return call;
  }

  updateCall(id: string, patch: WorkflowExecutionCallPatch): void {
    const call = this.#call(id);
    if (this.#sealed) return;
    Object.assign(call, patch);
    call.timestamps.updatedAt = now();
    if (
      patch.status === WORKFLOW_CALL_STATUS.QUEUED ||
      patch.status === WORKFLOW_CALL_STATUS.RUNNING
    ) {
      this.#snapshot.lifecycle = WORKFLOW_EXECUTION_LIFECYCLE.ACTIVE;
    }
    this.#refreshExitedStage(call.stageId);
    this.#emit();
  }

  /**
   * Terminalize one call: the caller owns the status (and error); the
   * completion stamp is this owner's, so no caller re-reads and re-writes the
   * timestamps it does not own.
   */
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
    const call = this.#call(id);
    this.updateCall(id, {
      ...patch,
      timestamps: { ...call.timestamps, completedAt: now() },
    });
  }

  /**
   * Queue a call for a concurrency slot. Live-attempt facts of a prior attempt
   * are dropped — a stale resolved model must not describe the attempt about
   * to start — while the model the script itself declared stays visible
   * until the host reports what it resolved.
   */
  queueCall(id: string, declared: { readonly model?: string } = {}): void {
    const call = this.#call(id);
    const timestamp = now();
    // Interactive retry re-queues a still-live call: keep the logical start so
    // duration covers every physical attempt. A terminal call re-queued after
    // identity change / resume must start a fresh execution window instead.
    const preserveStartedAt =
      call.timestamps.startedAt !== undefined &&
      !TERMINAL_WORKFLOW_CALL_STATUSES.has(call.status);
    this.updateCall(id, {
      status: WORKFLOW_CALL_STATUS.QUEUED,
      childExecutionId: undefined,
      childStreamId: undefined,
      model: declared.model,
      settledBySweep: undefined,
      error: undefined,
      timestamps: {
        createdAt: call.timestamps.createdAt,
        ...(preserveStartedAt && { startedAt: call.timestamps.startedAt }),
        updatedAt: timestamp,
      },
    });
  }

  beginAttempt(id: string): void {
    if (this.#sealed) return;
    const call = this.#call(id);
    const startedAt = now();
    call.attempts.push({ number: call.attempts.length + 1, startedAt });
    call.status = WORKFLOW_CALL_STATUS.RUNNING;
    call.timestamps.startedAt ??= startedAt;
    call.timestamps.updatedAt = startedAt;
    this.#snapshot.lifecycle = WORKFLOW_EXECUTION_LIFECYCLE.ACTIVE;
    this.#emit();
  }

  /**
   * Stamp host-resolved facts onto the call and its latest attempt. Each fact
   * is independent — an omitted one leaves the current value in place — and the
   * whole patch lands in one transition, so no observer sees a half-applied
   * report.
   */
  reportAttempt(id: string, facts: Omit<WorkflowAttemptFacts, 'agent'>): void {
    if (this.#sealed) return;
    const call = this.#call(id);
    const attempt = call.attempts.at(-1);
    if (facts.childExecutionId !== undefined) {
      call.childExecutionId = facts.childExecutionId;
      if (attempt) attempt.id = facts.childExecutionId;
    }
    if (facts.childStreamId !== undefined) {
      call.childStreamId = facts.childStreamId;
      if (attempt) attempt.childStreamId = facts.childStreamId;
    }
    if (facts.model !== undefined) {
      call.model = facts.model;
      if (attempt) attempt.model = facts.model;
    }
    if (facts.costUsd !== undefined) {
      if (attempt) attempt.costUsd = facts.costUsd;
      call.costUsd = totalAttemptCost(call.attempts);
    }
    call.timestamps.updatedAt = now();
    this.#emit();
  }

  settleAttempt(id: string): boolean {
    if (this.#sealed) return false;
    const call = this.#call(id);
    const attempt = call.attempts.at(-1);
    if (attempt && attempt.completedAt === undefined) {
      attempt.completedAt = now();
      call.timestamps.updatedAt = now();
      this.#emit();
    }
    return true;
  }

  finish(
    lifecycle: 'completed' | 'failed' | 'cancelled',
    error?: string,
  ): void {
    if (this.#sealed) return;
    const completedAt = now();
    // Capture before clearing so orchestration failures can terminalize the
    // stage the script was inside even when no call encodes that failure.
    const activeStageId = this.#snapshot.currentStageId;
    this.#snapshot.lifecycle = lifecycle;
    this.#snapshot.currentStageId = undefined;
    this.#snapshot.timestamps.completedAt = completedAt;
    if (error) this.#snapshot.error = error;
    const sweepSettledStageIds = new Set<string>();
    for (const [index, call] of this.#snapshot.calls.entries()) {
      const attempts = call.attempts.map((attempt, attemptIndex) =>
        attemptIndex === call.attempts.length - 1 &&
        attempt.completedAt === undefined
          ? { ...attempt, completedAt }
          : attempt,
      );
      const timestamps = {
        ...call.timestamps,
        updatedAt: completedAt,
        completedAt,
      };
      if (
        call.status === WORKFLOW_CALL_STATUS.PLANNED ||
        call.status === WORKFLOW_CALL_STATUS.STAGE_BLOCKED
      ) {
        if (call.stageId) sweepSettledStageIds.add(call.stageId);
        this.#snapshot.calls[index] = {
          ...call,
          attempts,
          status: WORKFLOW_CALL_STATUS.SKIPPED,
          settledBySweep: true,
          timestamps,
        };
      } else if (
        call.status === WORKFLOW_CALL_STATUS.QUEUED ||
        call.status === WORKFLOW_CALL_STATUS.RUNNING
      ) {
        if (call.stageId) sweepSettledStageIds.add(call.stageId);
        this.#snapshot.calls[index] =
          lifecycle === WORKFLOW_EXECUTION_LIFECYCLE.CANCELLED
            ? {
                ...call,
                attempts,
                status: WORKFLOW_CALL_STATUS.CANCELLED,
                settledBySweep: true,
                timestamps,
              }
            : {
                ...call,
                attempts,
                status: WORKFLOW_CALL_STATUS.FAILED,
                settledBySweep: true,
                error: WORKFLOW_CALL_UNFINISHED_NOTE,
                timestamps,
              };
      }
    }
    for (const stage of this.#snapshot.stages) {
      if (stage.lifecycle === WORKFLOW_EXECUTION_LIFECYCLE.WAITING) {
        stage.lifecycle = WORKFLOW_EXECUTION_LIFECYCLE.SKIPPED;
        stage.completedAt = completedAt;
      } else {
        // Re-derive the lifecycle after the call sweep above. A stage whose
        // call the sweep just terminalized ends now; genuinely settled stages
        // keep their own end instant rather than taking the run's terminal one.
        this.#settleStage(
          stage.id,
          sweepSettledStageIds.has(stage.id)
            ? completedAt
            : (stage.completedAt ?? completedAt),
        );
      }
    }
    // Call-derived settlement alone can mark the active stage completed or
    // skipped when the script threw/cancelled after phase() with no live
    // failed call (e.g. a JS reduction error). Force the active stage to the
    // workflow terminal lifecycle so /executions/{id} shows where orchestration
    // failed.
    if (
      activeStageId !== undefined &&
      (lifecycle === WORKFLOW_EXECUTION_LIFECYCLE.FAILED ||
        lifecycle === WORKFLOW_EXECUTION_LIFECYCLE.CANCELLED)
    ) {
      const activeStage = this.#snapshot.stages.find(
        (stage) => stage.id === activeStageId,
      );
      if (activeStage) {
        // Guarded above to lifecycle === FAILED | CANCELLED, so the lifecycle
        // is its own mapping.
        activeStage.lifecycle = lifecycle;
        activeStage.completedAt = completedAt;
      }
    }
    this.#emit();
    this.#sealed = true;
  }

  #refreshExitedStage(stageId: string | undefined): void {
    if (!stageId || stageId === this.#snapshot.currentStageId) return;
    const calls = this.#snapshot.calls.filter(
      (call) => call.stageId === stageId,
    );
    if (
      calls.every((call) => TERMINAL_WORKFLOW_CALL_STATUSES.has(call.status))
    ) {
      this.#settleStage(stageId, now());
    }
  }

  #settleStage(stageId: string, completedAt: string): void {
    const stage = this.#snapshot.stages.find(
      (candidate) => candidate.id === stageId,
    );
    if (!stage) return;
    const calls = this.#snapshot.calls.filter(
      (call) => call.stageId === stageId,
    );
    if (
      calls.length === 0 ||
      calls.every((call) => call.status === WORKFLOW_CALL_STATUS.SKIPPED)
    ) {
      stage.lifecycle = WORKFLOW_EXECUTION_LIFECYCLE.SKIPPED;
    } else if (
      calls.some((call) => call.status === WORKFLOW_CALL_STATUS.FAILED)
    ) {
      stage.lifecycle = WORKFLOW_EXECUTION_LIFECYCLE.FAILED;
    } else if (
      calls.some((call) => call.status === WORKFLOW_CALL_STATUS.CANCELLED)
    ) {
      stage.lifecycle = WORKFLOW_EXECUTION_LIFECYCLE.CANCELLED;
    } else {
      stage.lifecycle = WORKFLOW_EXECUTION_LIFECYCLE.COMPLETED;
    }
    stage.completedAt = completedAt;
  }

  #emit(): void {
    this.#snapshot.timestamps.updatedAt = now();
    // Live reference by contract (see the publish option): coalesced-away
    // publications then never pay a full structuredClone of the snapshot.
    this.#publish(this.#snapshot);
  }
}

function now(): string {
  return new Date().toISOString();
}

function stageIdFor(index: number): string {
  return `stage-${index + 1}`;
}

function totalAttemptCost(
  attempts: WorkflowExecutionCall['attempts'],
): number | undefined {
  return attempts.some((attempt) => attempt.costUsd !== undefined)
    ? attempts.reduce((total, attempt) => total + (attempt.costUsd ?? 0), 0)
    : undefined;
}

/** Whether a hydrated call's prior result can be replayed as-is. */
type ReusableWorkflowExecutionCall = Extract<
  WorkflowExecutionCall,
  { readonly status: 'completed' | 'cached' }
>;

function isReusableCall(
  call: WorkflowExecutionCall,
): call is ReusableWorkflowExecutionCall {
  return (
    call.status === WORKFLOW_CALL_STATUS.COMPLETED ||
    call.status === WORKFLOW_CALL_STATUS.CACHED
  );
}

function isReusableStatus(status: WorkflowExecutionCall['status']): boolean {
  return (
    status === WORKFLOW_CALL_STATUS.COMPLETED ||
    status === WORKFLOW_CALL_STATUS.CACHED
  );
}

function closeOpenAttempts(
  attempts: WorkflowExecutionCall['attempts'],
  recoveryAt: string,
): WorkflowExecutionCall['attempts'] {
  return attempts.map((attempt) =>
    attempt.completedAt === undefined
      ? { ...attempt, completedAt: recoveryAt }
      : attempt,
  );
}

function hydrate(
  fresh: WorkflowExecutionSnapshot,
  persisted: WorkflowExecutionSnapshot | undefined,
  recoveryAt: string,
): WorkflowExecutionSnapshot {
  if (!persisted) return fresh;
  const snapshot = structuredClone(fresh);
  snapshot.timestamps.createdAt = persisted.timestamps.createdAt;
  const freshIds = new Set(snapshot.calls.map((call) => call.id));
  const priorById = new Map(persisted.calls.map((call) => [call.id, call]));
  snapshot.calls = snapshot.calls.map((call) => {
    const prior = priorById.get(call.id);
    if (!prior) return call;
    const attempts = closeOpenAttempts(prior.attempts, recoveryAt);
    if (isReusableCall(prior)) {
      return {
        ...prior,
        label: call.label,
        stageId: call.stageId,
        attempts,
        costUsd: totalAttemptCost(attempts),
      };
    }
    if (
      call.status !== WORKFLOW_CALL_STATUS.PLANNED &&
      call.status !== WORKFLOW_CALL_STATUS.STAGE_BLOCKED
    ) {
      throw new Error(`Fresh workflow call ${call.id} is not a plan stub.`);
    }
    return {
      ...call,
      attempts,
      costUsd: totalAttemptCost(attempts),
      timestamps: {
        createdAt: prior.timestamps.createdAt,
        updatedAt: recoveryAt,
      },
    };
  });
  for (const prior of persisted.calls) {
    if (freshIds.has(prior.id)) continue;
    const attempts = closeOpenAttempts(prior.attempts, recoveryAt);
    if (isReusableCall(prior)) {
      snapshot.calls.push({
        ...prior,
        stageId: undefined,
        attempts,
        costUsd: totalAttemptCost(attempts),
      });
      continue;
    }
    snapshot.calls.push({
      id: prior.id,
      label: prior.label,
      files: prior.files,
      attempts,
      costUsd: totalAttemptCost(attempts),
      status: WORKFLOW_CALL_STATUS.PLANNED,
      timestamps: {
        createdAt: prior.timestamps.createdAt,
        updatedAt: recoveryAt,
      },
    });
  }
  return snapshot;
}
