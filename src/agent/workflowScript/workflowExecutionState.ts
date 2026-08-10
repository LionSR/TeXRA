import {
  TERMINAL_WORKFLOW_CALL_STATUSES,
  WORKFLOW_CALL_STATUS,
  WORKFLOW_EXECUTION_LIFECYCLE,
  type ExecutionId,
  type StreamTabId,
  type WorkflowExecutionCall,
  type WorkflowExecutionSnapshot,
} from '@shared/schemas';

import type { WorkflowScriptTask } from './types';

interface WorkflowCallDefinition {
  readonly id: string;
  readonly label: string;
  readonly phase?: string;
  readonly agent?: string;
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
    readonly tasks: readonly WorkflowScriptTask[];
    readonly initialSnapshot?: WorkflowExecutionSnapshot;
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
            stageTitle: task.phase,
          }),
          files: { input: [], context: [], media: [] },
          attempts: [],
          status:
            task.phase === undefined
              ? WORKFLOW_CALL_STATUS.PLANNED
              : WORKFLOW_CALL_STATUS.STAGE_BLOCKED,
          ...(task.phase !== undefined && {
            blockedReason: `Waiting for stage ${task.phase}`,
          }),
          timestamps: { createdAt: timestamp, updatedAt: timestamp },
        };
      }),
      counts: emptyCounts(),
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

  enterStage(title: string): number {
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
    if (nextIndex === currentStageIndex) return nextIndex;

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
    for (const call of this.#snapshot.calls) {
      if (
        call.stageId === active.id &&
        call.status === WORKFLOW_CALL_STATUS.STAGE_BLOCKED
      ) {
        call.status = WORKFLOW_CALL_STATUS.PLANNED;
        call.blockedReason = undefined;
        call.timestamps.updatedAt = transitionAt;
      }
    }
    this.#emit();
    return nextIndex;
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
    const canonical = {
      label: definition.label,
      stageId: stageIndex < 0 ? undefined : stageIdFor(stageIndex),
      stageTitle: definition.phase,
      agent: definition.agent,
      files: definition.files,
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
      Object.assign(call, canonical);
      call.timestamps.updatedAt = timestamp;
    }
    this.#emit();
  }

  call(id: string): WorkflowExecutionCall {
    const call = this.#snapshot.calls.find((candidate) => candidate.id === id);
    if (!call) throw new Error(`Workflow snapshot call ${id} is missing.`);
    return call;
  }

  updateCall(
    id: string,
    patch: Partial<WorkflowExecutionCall>,
  ): WorkflowExecutionCall {
    const call = this.call(id);
    if (this.#sealed) return call;
    Object.assign(call, patch);
    call.timestamps.updatedAt = now();
    if (
      patch.status === WORKFLOW_CALL_STATUS.QUEUED ||
      patch.status === WORKFLOW_CALL_STATUS.STARTING ||
      patch.status === WORKFLOW_CALL_STATUS.RUNNING
    ) {
      this.#snapshot.lifecycle = WORKFLOW_EXECUTION_LIFECYCLE.ACTIVE;
    }
    this.#refreshExitedStage(call.stageId);
    this.#emit();
    return call;
  }

  queueCall(id: string): void {
    const call = this.call(id);
    const queuedAt = now();
    this.updateCall(id, {
      status: WORKFLOW_CALL_STATUS.QUEUED,
      childExecutionId: undefined,
      childStreamId: undefined,
      model: undefined,
      blockedReason: undefined,
      error: undefined,
      timestamps: {
        createdAt: call.timestamps.createdAt,
        queuedAt,
        updatedAt: queuedAt,
      },
    });
  }

  beginAttempt(id: string): void {
    if (this.#sealed) return;
    const call = this.call(id);
    const startedAt = now();
    call.attempts.push({ number: call.attempts.length + 1, startedAt });
    call.status = WORKFLOW_CALL_STATUS.STARTING;
    call.timestamps.startedAt ??= startedAt;
    call.timestamps.updatedAt = startedAt;
    this.#snapshot.lifecycle = WORKFLOW_EXECUTION_LIFECYCLE.ACTIVE;
    this.#emit();
  }

  reportChildExecution(id: string, executionId: ExecutionId): void {
    if (this.#sealed) return;
    const call = this.call(id);
    call.childExecutionId = executionId;
    const attempt = call.attempts.at(-1);
    if (attempt) attempt.id = executionId;
    call.timestamps.updatedAt = now();
    this.#emit();
  }

  reportChildStream(id: string, streamId: StreamTabId): void {
    if (this.#sealed) return;
    const call = this.call(id);
    call.childStreamId = streamId;
    const attempt = call.attempts.at(-1);
    if (attempt) attempt.childStreamId = streamId;
    call.timestamps.updatedAt = now();
    this.#emit();
  }

  reportModel(id: string, model: string): void {
    if (this.#sealed) return;
    const call = this.call(id);
    call.model = model;
    const attempt = call.attempts.at(-1);
    if (attempt) attempt.model = model;
    call.timestamps.updatedAt = now();
    this.#emit();
  }

  reportCostUsd(id: string, costUsd: number): void {
    if (this.#sealed) return;
    const call = this.call(id);
    const attempt = call.attempts.at(-1);
    if (attempt) attempt.costUsd = costUsd;
    call.costUsd = totalAttemptCost(call.attempts);
    call.timestamps.updatedAt = now();
    this.#emit();
  }

  settleAttempt(id: string): boolean {
    if (this.#sealed) return false;
    const call = this.call(id);
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
    this.#snapshot.lifecycle = lifecycle;
    this.#snapshot.currentStageId = undefined;
    this.#snapshot.timestamps.completedAt = completedAt;
    if (error) this.#snapshot.error = error;
    for (const call of this.#snapshot.calls) {
      const latestAttempt = call.attempts.at(-1);
      if (latestAttempt && latestAttempt.completedAt === undefined) {
        latestAttempt.completedAt = completedAt;
      }
      if (
        call.status === WORKFLOW_CALL_STATUS.PLANNED ||
        call.status === WORKFLOW_CALL_STATUS.STAGE_BLOCKED
      ) {
        call.status = WORKFLOW_CALL_STATUS.SKIPPED;
        call.blockedReason = 'Workflow ended before this call was reached';
        call.timestamps.completedAt = completedAt;
        call.timestamps.updatedAt = completedAt;
      } else if (
        call.status === WORKFLOW_CALL_STATUS.QUEUED ||
        call.status === WORKFLOW_CALL_STATUS.STARTING ||
        call.status === WORKFLOW_CALL_STATUS.RUNNING
      ) {
        call.status =
          lifecycle === WORKFLOW_EXECUTION_LIFECYCLE.CANCELLED
            ? WORKFLOW_CALL_STATUS.CANCELLED
            : WORKFLOW_CALL_STATUS.FAILED;
        call.error ??= 'Workflow ended before this call completed';
        call.timestamps.completedAt = completedAt;
        call.timestamps.updatedAt = completedAt;
      }
    }
    for (const stage of this.#snapshot.stages) {
      if (stage.lifecycle === WORKFLOW_EXECUTION_LIFECYCLE.WAITING) {
        stage.lifecycle = WORKFLOW_EXECUTION_LIFECYCLE.SKIPPED;
        stage.completedAt = completedAt;
      } else {
        this.#settleStage(stage.id, completedAt);
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
    const counts = emptyCounts();
    for (const call of this.#snapshot.calls) counts[call.status] += 1;
    counts.total = this.#snapshot.calls.length;
    counts.waiting = counts.planned + counts.stageBlocked;
    this.#snapshot.counts = counts;
    this.#snapshot.timestamps.updatedAt = now();
    this.#publish(structuredClone(this.#snapshot));
  }
}

function now(): string {
  return new Date().toISOString();
}

function stageIdFor(index: number): string {
  return `stage-${index + 1}`;
}

function emptyCounts(): WorkflowExecutionSnapshot['counts'] {
  return {
    total: 0,
    waiting: 0,
    planned: 0,
    stageBlocked: 0,
    queued: 0,
    starting: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    cached: 0,
  };
}

function totalAttemptCost(
  attempts: WorkflowExecutionCall['attempts'],
): number | undefined {
  const costs = attempts.flatMap((attempt) =>
    attempt.costUsd === undefined ? [] : [attempt.costUsd],
  );
  return costs.length === 0
    ? undefined
    : costs.reduce((total, costUsd) => total + costUsd, 0);
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
    const reusable =
      prior.status === WORKFLOW_CALL_STATUS.COMPLETED ||
      prior.status === WORKFLOW_CALL_STATUS.CACHED;
    const attempts = closeOpenAttempts(prior.attempts, recoveryAt);
    return {
      ...prior,
      label: call.label,
      stageId: call.stageId,
      stageTitle: call.stageTitle,
      files: call.files,
      attempts,
      costUsd: totalAttemptCost(attempts),
      status: reusable ? prior.status : call.status,
      ...(!reusable && {
        childExecutionId: undefined,
        childStreamId: undefined,
        model: undefined,
        blockedReason: call.blockedReason,
        error: undefined,
        timestamps: {
          createdAt: prior.timestamps.createdAt,
          updatedAt: recoveryAt,
        },
      }),
    };
  });
  for (const prior of persisted.calls) {
    if (!freshIds.has(prior.id)) {
      const reusable =
        prior.status === WORKFLOW_CALL_STATUS.COMPLETED ||
        prior.status === WORKFLOW_CALL_STATUS.CACHED;
      const attempts = closeOpenAttempts(prior.attempts, recoveryAt);
      snapshot.calls.push({
        ...prior,
        stageId: undefined,
        stageTitle: undefined,
        attempts,
        costUsd: totalAttemptCost(attempts),
        status: reusable ? prior.status : WORKFLOW_CALL_STATUS.PLANNED,
        ...(!reusable && {
          childExecutionId: undefined,
          childStreamId: undefined,
          model: undefined,
          blockedReason: undefined,
          error: undefined,
          timestamps: {
            createdAt: prior.timestamps.createdAt,
            updatedAt: recoveryAt,
          },
        }),
      });
    }
  }
  return snapshot;
}
