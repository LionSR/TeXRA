import {
  RUN_OUTCOME,
  TERMINAL_WORKFLOW_CALL_STATUSES,
  WORKFLOW_CALL_STATUS,
  type RunOutcome,
  type WorkflowCallIdentity,
  type WorkflowCallKind,
  type WorkflowRunCall,
  type WorkflowRunSnapshot,
} from '@shared/schemas';
import { WORKFLOW_CALL_UNFINISHED_NOTE } from '@shared/copy/workflowCall';

import type { WorkflowAttemptFacts } from './types';

interface WorkflowCallDefinition {
  readonly id: string;
  readonly label: string;
  readonly phase?: string;
  readonly kind: WorkflowCallKind;
  readonly agent?: string;
  /** Model the script declared for this call; the host may still substitute. */
  readonly model?: string;
  readonly files: WorkflowRunCall['files'];
}

type WorkflowCallRecoverySource = (
  { readonly id: string } | { readonly implicitIndex: number }
) & { readonly journalProven: boolean };

/** Owns canonical workflow stage/call transitions and interrupted-run hydration. */
export class WorkflowRunState {
  readonly #snapshot: WorkflowRunSnapshot;
  readonly #persistedCalls: readonly WorkflowRunCall[];
  readonly #recoveryAt: string;
  readonly #publish: (snapshot: WorkflowRunSnapshot) => void;
  readonly #hasDeclaredStages: boolean;
  readonly #issuedCallIds = new Set<string>();
  #sealed = false;

  constructor(options: {
    readonly phases: readonly { readonly title: string }[];
    readonly tasks: readonly WorkflowCallIdentity[];
    readonly initialSnapshot?: WorkflowRunSnapshot;
    /**
     * Receives the live snapshot on every transition, not a copy. Consumers
     * that retain it or persist asynchronously must clone it first (the
     * runner's snapshot writer clones at drain time).
     */
    readonly publish: (snapshot: WorkflowRunSnapshot) => void;
  }) {
    this.#publish = options.publish;
    this.#hasDeclaredStages = options.phases.length > 0;
    const createdAt = now();
    this.#recoveryAt = createdAt;
    this.#persistedCalls = structuredClone(
      options.initialSnapshot?.calls ?? [],
    );
    const fresh: WorkflowRunSnapshot = {
      stages: options.phases.map((phase, index) => ({
        id: stageIdFor(index),
        title: phase.title,
        order: index,
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
          status: WORKFLOW_CALL_STATUS.DECLARED,
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

  snapshot(): WorkflowRunSnapshot {
    return structuredClone(this.#snapshot);
  }

  enterStage(title: string): void {
    if (this.#sealed) throw new Error('Workflow run state is sealed.');
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
      });
    }
    const currentStageIndex = this.currentPhaseIndex;
    if (nextIndex < currentStageIndex) {
      throw new Error(
        `Workflow stages must advance monotonically; cannot enter "${title}" after ${this.currentPhase ?? 'the same stage'}.`,
      );
    }
    if (nextIndex === currentStageIndex) return;

    const active = this.#snapshot.stages[nextIndex];
    active.startedAt ??= now();
    this.#snapshot.currentStageId = active.id;
    this.#emit();
  }

  issueCall(
    definition: WorkflowCallDefinition,
    recoverySource?: WorkflowCallRecoverySource,
  ): void {
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
    // Re-issuing on resume must not wipe a recovered agent with undefined —
    // the journal-cache path only patches status/timestamps and would leave
    // /executions without the resolved agent after a cached replay.
    const canonical = {
      label: definition.label,
      stageId: stageIndex < 0 ? undefined : stageIdFor(stageIndex),
      kind: definition.kind,
      files: definition.files,
      ...(definition.agent !== undefined && { agent: definition.agent }),
      ...(definition.model !== undefined && { model: definition.model }),
    };
    const fresh: WorkflowRunCall = {
      id: definition.id,
      ...canonical,
      attempts: [],
      status: WORKFLOW_CALL_STATUS.QUEUED,
      timestamps: { createdAt: timestamp, updatedAt: timestamp },
    };
    let prior: WorkflowRunCall | undefined;
    if (recoverySource !== undefined) {
      const recoveryId =
        'id' in recoverySource
          ? recoverySource.id
          : `call-${recoverySource.implicitIndex}`;
      prior = this.#persistedCalls.find(
        (candidate) => candidate.id === recoveryId,
      );
    }
    const call = recoverCall(
      fresh,
      prior,
      this.#recoveryAt,
      recoverySource?.journalProven ?? false,
    );
    Object.assign(
      call,
      canonical,
      (isReusableStatus(call.status) || recoverySource?.journalProven) && {
        status: WORKFLOW_CALL_STATUS.QUEUED,
        timestamps: { createdAt: call.timestamps.createdAt },
      },
    );
    call.timestamps.updatedAt = timestamp;

    const existingIndex = this.#snapshot.calls.findIndex(
      (candidate) => candidate.id === definition.id,
    );
    if (existingIndex < 0) this.#snapshot.calls.push(call);
    else this.#snapshot.calls[existingIndex] = call;
    this.#emit();
  }

  #call(id: string): WorkflowRunCall {
    const call = this.#snapshot.calls.find((candidate) => candidate.id === id);
    if (!call) throw new Error(`Workflow snapshot call ${id} is missing.`);
    return call;
  }

  updateCall(id: string, patch: Partial<WorkflowRunCall>): void {
    const call = this.#call(id);
    if (this.#sealed) return;
    Object.assign(call, patch);
    call.timestamps.updatedAt = now();
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
    // identity change / resume must start a fresh run window instead.
    const preserveStartedAt =
      call.timestamps.startedAt !== undefined &&
      !TERMINAL_WORKFLOW_CALL_STATUSES.has(call.status);
    this.updateCall(id, {
      status: WORKFLOW_CALL_STATUS.QUEUED,
      childRunId: undefined,
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
    if (facts.childRunId !== undefined) {
      call.childRunId = facts.childRunId;
      if (attempt) attempt.id = facts.childRunId;
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
      const settledAt = now();
      attempt.completedAt = settledAt;
      call.timestamps.updatedAt = settledAt;
      this.#emit();
    }
    return true;
  }

  finish(outcome: RunOutcome, error?: string): void {
    if (this.#sealed) return;
    const completedAt = now();
    this.#snapshot.outcome = outcome;
    this.#snapshot.currentStageId = undefined;
    this.#snapshot.timestamps.completedAt = completedAt;
    if (error) this.#snapshot.error = error;
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
      if (call.status === WORKFLOW_CALL_STATUS.DECLARED) {
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
        this.#snapshot.calls[index] =
          outcome === RUN_OUTCOME.CANCELLED
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
                error: error ?? WORKFLOW_CALL_UNFINISHED_NOTE,
                timestamps,
              };
      }
    }
    this.#emit();
    this.#sealed = true;
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
  attempts: WorkflowRunCall['attempts'],
): number | undefined {
  return attempts.some((attempt) => attempt.costUsd !== undefined)
    ? attempts.reduce((total, attempt) => total + (attempt.costUsd ?? 0), 0)
    : undefined;
}

/** Whether a hydrated call's status means its prior result can be replayed as-is. */
function isReusableStatus(status: WorkflowRunCall['status']): boolean {
  return (
    status === WORKFLOW_CALL_STATUS.COMPLETED ||
    status === WORKFLOW_CALL_STATUS.CACHED
  );
}

function closeOpenAttempts(
  attempts: WorkflowRunCall['attempts'],
  recoveryAt: string,
): WorkflowRunCall['attempts'] {
  return attempts.map((attempt) =>
    attempt.completedAt === undefined
      ? { ...attempt, completedAt: recoveryAt }
      : attempt,
  );
}

function recoverCall(
  fresh: WorkflowRunCall,
  prior: WorkflowRunCall | undefined,
  recoveryAt: string,
  journalProven = false,
): WorkflowRunCall {
  if (!prior) return fresh;
  const attempts = closeOpenAttempts(prior.attempts, recoveryAt);
  if (isReusableStatus(prior.status) || journalProven) {
    return {
      ...prior,
      id: fresh.id,
      label: fresh.label,
      stageId: fresh.stageId,
      attempts,
      costUsd: totalAttemptCost(attempts),
    };
  }
  if (
    fresh.status !== WORKFLOW_CALL_STATUS.DECLARED &&
    fresh.status !== WORKFLOW_CALL_STATUS.QUEUED
  ) {
    throw new Error(`Fresh workflow call ${fresh.id} is not a plan stub.`);
  }
  return {
    ...fresh,
    attempts,
    costUsd: totalAttemptCost(attempts),
    timestamps: {
      createdAt: prior.timestamps.createdAt,
      updatedAt: recoveryAt,
    },
  };
}

function hydrate(
  fresh: WorkflowRunSnapshot,
  persisted: WorkflowRunSnapshot | undefined,
  recoveryAt: string,
): WorkflowRunSnapshot {
  if (!persisted) return fresh;
  const snapshot = structuredClone(fresh);
  snapshot.timestamps.createdAt = persisted.timestamps.createdAt;
  const freshIds = new Set(snapshot.calls.map((call) => call.id));
  const priorById = new Map(persisted.calls.map((call) => [call.id, call]));
  snapshot.calls = snapshot.calls.map((call) =>
    recoverCall(call, priorById.get(call.id), recoveryAt),
  );
  for (const prior of persisted.calls) {
    if (freshIds.has(prior.id)) continue;
    const attempts = closeOpenAttempts(prior.attempts, recoveryAt);
    if (isReusableStatus(prior.status)) {
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
      status: WORKFLOW_CALL_STATUS.DECLARED,
      timestamps: {
        createdAt: prior.timestamps.createdAt,
        updatedAt: recoveryAt,
      },
    });
  }
  return snapshot;
}
