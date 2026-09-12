// Third-party imports
import { Effect, Result } from 'effect';

// Local imports - agent runtime
import type { AgentTrace, StageHandle } from '@agent/trace';
import type { PersistedWorkflowScriptRunOptions } from '@agent/workflowScript/checkpoint';
import type {
  WorkflowAgentInvocation,
  WorkflowJournalEntry,
  WorkflowScriptEvent,
} from '@agent/workflowScript/types';
import {
  deriveWorkflowStageState,
  isTerminalWorkflowCallProgress,
  isTerminalWorkflowCallStatus,
  RUN_OUTCOME,
  stageTitleFor,
  WORKFLOW_CALL_STATUS,
  RunEndSchema,
  type RunOutcome,
  type WorkflowCallProgress,
  type WorkflowCallTerminalProgress,
  type WorkflowRunCall,
  type WorkflowRunSnapshot,
} from '@shared/schemas';
import {
  formatWorkflowCallLine,
  WORKFLOW_CALL_UNFINISHED_NOTE,
} from '@shared/copy/workflowCall';
import { generateShortId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * `onEvent` and `onTransition` are omitted deliberately: this projection owns
 * the engine's event and transition slots outright, so a caller cannot pass a
 * handler that would be silently discarded. Callers that need the run's own
 * account of what happened read the canonical run snapshot instead
 * (`onSnapshot` remains open and is composed, not replaced).
 */
type WorkflowScriptRunWithProgressOptions<R> = Omit<
  PersistedWorkflowScriptRunOptions<R>,
  'onEvent' | 'onTransition'
> & {
  /**
   * Receives every progress line also written to the trace (phases, script
   * log() output, per-call outcomes) so the caller can hand the run log back
   * to the invoking model, which otherwise cannot see any of it.
   */
  readonly onActivity?: (line: string) => void;
};

interface PhaseHandleState {
  readonly handle: StageHandle;
  failed: boolean;
}

function workflowJournalEntryCost(entry: WorkflowJournalEntry): number {
  const result = RunEndSchema.safeParse(entry.result);
  if (!result.success) {
    throw new Error(
      `Workflow journal entry ${entry.index} is not a run result.`,
      { cause: result.error },
    );
  }
  // No usage recorded is no spend.
  return result.data.usage?.totalCost ?? 0;
}

/**
 * Keys are unique per run (the engine faults duplicates), so the key alone
 * identifies an attempt; a replayed entry re-journaled at a new index still
 * matches the attempt that produced it.
 */
type WorkflowAttemptIdentity = Pick<WorkflowAgentInvocation, 'index' | 'key'>;

interface WorkflowAttemptCostTracker {
  /** Record one physical child attempt and return this tool invocation's live total. */
  record(invocation: WorkflowAttemptIdentity, costUsd: number): number;
  /**
   * Return this tool invocation's final total. Replayed/recovered journal
   * entries with no physical-attempt callback contribute zero.
   */
  total(finalJournal: readonly WorkflowJournalEntry[]): number;
}

/**
 * Track one tool invocation's physical attempts in callback order per journal
 * key. The production child runner emits exactly one callback for every
 * physical attempt, including `undefined` cost (normalized to zero), and emits
 * none for replay or stable recovery. For a completed key, all callbacks but
 * the last are discarded retries; only the last can correspond to the journal
 * result, so its charge is `max(observer, journal)` rather than another sum.
 * `record` and `total` therefore return comparable attempt-scoped USD totals
 * for the loop-owned best-value latch without charging historical entries.
 *
 * This is the workflow path's conversion step in the shared cost contract
 * (`ChildRunPorts` in `@agent/runtime/childRunLoop`): the loop retains
 * max(best) over *cumulative* observations, so this tracker turns the
 * engine's per-attempt deltas into invocation-cumulative totals before they
 * reach `recordCost`. `total()` never undercuts the live-observed sum — the
 * journal fallback only raises a completed key's last attempt.
 */
export function createWorkflowAttemptCostTracker(): WorkflowAttemptCostTracker {
  const attemptsByIdentity = new Map<string, number[]>();
  let observedTotalUsd = 0;

  return {
    record: (invocation, costUsd) => {
      observedTotalUsd += costUsd;
      const attempts = attemptsByIdentity.get(invocation.key) ?? [];
      attempts.push(costUsd);
      attemptsByIdentity.set(invocation.key, attempts);
      return observedTotalUsd;
    },
    total: (finalJournal) => {
      const journalIdentities = new Set<string>();
      let totalUsd = 0;
      for (const entry of finalJournal) {
        journalIdentities.add(entry.key);
        const journalCostUsd = workflowJournalEntryCost(entry);
        const attempts = attemptsByIdentity.get(entry.key);
        if (!attempts || attempts.length === 0) continue;
        for (const discardedCostUsd of attempts.slice(0, -1)) {
          totalUsd += discardedCostUsd;
        }
        totalUsd += Math.max(attempts.at(-1) ?? 0, journalCostUsd);
      }
      for (const [identity, attempts] of attemptsByIdentity) {
        if (!journalIdentities.has(identity)) {
          totalUsd += attempts.reduce((sum, costUsd) => sum + costUsd, 0);
        }
      }
      return totalUsd;
    },
  };
}

/**
 * The progress projection of one durable workflow-script run onto the parent
 * trace: the run options with the engine's event and transition slots bound,
 * and the settle step the caller runs once the run has ended either way.
 */
export interface WorkflowScriptProgressProjection<R> {
  readonly options: PersistedWorkflowScriptRunOptions<R>;
  /** Close every phase the run left open; `completed` names how it ended. */
  readonly settle: (completed: boolean) => void;
}

/**
 * Project a durable workflow script's progress onto the parent trace. The
 * caller runs `options` through `runPersistedWorkflowScript` and calls
 * `settle` in a finalizer. Its synchronous projection state remains local;
 * snapshot persistence is composed as an Effect so it shares the caller's
 * runtime and lifecycle.
 */
export function projectWorkflowScriptProgress<R>(
  trace: AgentTrace,
  options: WorkflowScriptRunWithProgressOptions<R>,
): WorkflowScriptProgressProjection<R> {
  const { onActivity, ...runOptions } = options;
  const parentStageId = trace.activeStageId();
  const phases = new Map<string, PhaseHandleState>();
  // A deterministic workflow stream appends every relaunch to one transcript.
  // Keep one card identity through this projection's state transitions without
  // colliding with the same logical call in an earlier attempt.
  const projectionId = generateShortId();
  const projectedCalls = new Map<
    WorkflowCallProgress['id'],
    WorkflowCallProgress
  >();
  // The engine terminalizes and flushes its snapshot before returning or
  // rethrowing, so the last one published is its final account of every call —
  // what the settle sweep below reads instead of re-deciding outcomes here.
  let lastSnapshot: WorkflowRunSnapshot | undefined;
  let currentPhase: string | undefined;
  let closed = false;
  // Calls that were already terminal when a retry's hydrated state first
  // emitted (see the fold): historical facts, projected only on change.
  const hydratedBaseline = new Map<
    WorkflowCallProgress['id'],
    {
      status: WorkflowCallProgress['status'];
      childRunId: WorkflowCallProgress['childRunId'];
    }
  >();
  let constructionEmissionSeen = false;
  let planEmitted = false;
  let runOutcome: RunOutcome = RUN_OUTCOME.FAILED;

  const phaseFor = (
    title: string,
    index?: number,
    total?: number,
  ): PhaseHandleState => {
    const existing = phases.get(title);
    if (existing) return existing;
    const phase = {
      handle: trace.openStage(title, {
        kind: 'phase',
        parentId: parentStageId,
        index,
        total,
      }),
      failed: false,
    };
    phases.set(title, phase);
    return phase;
  };

  /**
   * Open a phase stage once the run reaches it and answer the stage rows
   * emitted from there belong to. Callers that only need the phase opened
   * ignore the return.
   */
  const openPhaseHandle = (phase: string | undefined): string | undefined =>
    phase ? phaseFor(phase).handle.id : parentStageId;

  const recordTerminalActivity = (call: WorkflowCallTerminalProgress): void => {
    onActivity?.(formatWorkflowCallLine(call));
  };
  /**
   * A card's `phase` is the engine's own record: `stageId` is pinned when the
   * call is issued and a declared task issued elsewhere is a contract fault,
   * so the phase on the card and the group it is emitted under are one fact.
   * Cards are emitted only once the fold (or the settle sweep) has opened
   * their phase, so the group is the stage handle that already exists.
   */
  const emitCall = (call: WorkflowCallProgress): void => {
    const card: WorkflowCallProgress = { ...call, attemptId: projectionId };
    projectedCalls.set(call.id, card);
    trace.emit({
      type: 'workflow.call',
      // Stable trace identity for this call within its run stream.
      logId: `workflow-task-${projectionId}-${call.id}`,
      call: card,
      stageId: openPhaseHandle(card.phase),
    });
  };
  const markPhaseFailed = (title: string | undefined): void => {
    if (title) phaseFor(title).failed = true;
  };

  const projectLog = (event: WorkflowScriptEvent): void => {
    if (closed) return;
    trace.info(event.message, { stageId: openPhaseHandle(currentPhase) });
    onActivity?.(event.message);
  };

  /** Progress-only terminal metadata, read off the snapshot's own record. */
  const terminalMetadata = (
    call: Extract<
      WorkflowRunCall,
      { readonly status: 'completed' | 'failed' | 'cancelled' | 'skipped' }
    >,
  ) => {
    const model = call.model ?? call.attempts.at(-1)?.model;
    const { startedAt, completedAt } = call.timestamps;
    const durationMs =
      startedAt !== undefined
        ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
        : undefined;
    return {
      ...(model !== undefined && { model }),
      ...(durationMs !== undefined && { durationMs }),
      costUsd: call.costUsd,
    };
  };

  const cardFor = (
    call: WorkflowRunCall,
    snapshot: WorkflowRunSnapshot,
  ): WorkflowCallProgress => {
    const { status } = call;
    const phase = stageTitleFor(snapshot, call);
    // The latest attempt describes this card only once it has begun: a
    // re-queued call has not pushed its next attempt yet, and a cached or
    // swept card reflects no attempt of this run.
    const attemptCounts =
      call.attempts.length > 1 &&
      (status === 'running' ||
        status === 'completed' ||
        status === 'failed' ||
        status === 'cancelled' ||
        (status === 'skipped' && !call.settledBySweep));
    const hasInvocationFacts =
      call.kind !== undefined ||
      call.agent !== undefined ||
      call.model !== undefined ||
      call.childRunId !== undefined ||
      call.attempts.length > 0 ||
      call.timestamps.startedAt !== undefined;
    const includeFiles =
      (status !== WORKFLOW_CALL_STATUS.DECLARED &&
        status !== WORKFLOW_CALL_STATUS.SKIPPED) ||
      hasInvocationFacts;
    const identity = {
      id: call.id,
      label: call.label,
      ...(phase !== undefined ? { phase } : {}),
      ...(call.childRunId !== undefined ? { childRunId: call.childRunId } : {}),
      // Project only invocation facts the snapshot owns.
      ...(call.kind !== undefined && { kind: call.kind }),
      ...(call.agent !== undefined && { agent: call.agent }),
      ...(call.model !== undefined && { model: call.model }),
      ...(includeFiles && { files: call.files }),
      ...(attemptCounts && { attemptNumber: call.attempts.length }),
    };
    switch (call.status) {
      case WORKFLOW_CALL_STATUS.FAILED: {
        // A sweep-settled call never reached its own settlement: its card
        // carries spend but no model/duration, the same shape the settle
        // sweep emits.
        const spentOnly =
          call.costUsd !== undefined ? { costUsd: call.costUsd } : {};
        return {
          ...identity,
          status: 'failed',
          error: call.error,
          ...(call.settledBySweep ? spentOnly : terminalMetadata(call)),
        };
      }
      case WORKFLOW_CALL_STATUS.COMPLETED:
        return { ...identity, status: 'completed', ...terminalMetadata(call) };
      case WORKFLOW_CALL_STATUS.CANCELLED:
        return { ...identity, status: 'cancelled', ...terminalMetadata(call) };
      case WORKFLOW_CALL_STATUS.SKIPPED:
        // The sweep settles not-reached plans; a user skip settles itself.
        return call.settledBySweep
          ? { ...identity, status: 'skipped', reason: 'not-reached' }
          : {
              ...identity,
              status: 'skipped',
              reason: 'user',
              ...terminalMetadata(call),
            };
      case WORKFLOW_CALL_STATUS.DECLARED:
      case WORKFLOW_CALL_STATUS.QUEUED:
      case WORKFLOW_CALL_STATUS.RUNNING:
      case WORKFLOW_CALL_STATUS.CACHED:
        return { ...identity, status: call.status };
    }
  };

  // Declared stages are the ones present on the first folded snapshot; a
  // dynamically entered phase appended later carries no declared position.
  let declaredStageTotal: number | undefined;

  /**
   * Fold one canonical snapshot into the trace-card projection. The snapshot
   * is the single owner of every run fact (A7); this fold derives card
   * transitions by diffing against what it last emitted. Called synchronously
   * on every state transition with the engine's live snapshot reference —
   * everything is read here, nothing retained. A projection fault must never
   * abort the run, so the fold guards itself and reports on the run trace.
   */
  const fold = (snapshot: WorkflowRunSnapshot): void => {
    if (closed) return;
    // A call carried into the construction emission is hydrated history, not
    // this attempt's activity. Reusable calls are terminal here; failed or
    // cancelled calls were reset to planned, but retain an earlier creation
    // timestamp or attempt record. Record either shape silently, ahead of any
    // projection work, so a fault below can never promote history to current
    // work. Emitting a hydrated dynamic call would freeze the identity before
    // `issueCall` restores its phase, and a call absent from this script
    // would appear as current-attempt not-reached work.
    if (!constructionEmissionSeen) {
      constructionEmissionSeen = true;
      for (const call of snapshot.calls) {
        const { status } = call;
        if (
          isTerminalWorkflowCallStatus(status) ||
          call.attempts.length > 0 ||
          call.timestamps.createdAt !== call.timestamps.updatedAt
        ) {
          hydratedBaseline.set(call.id, {
            status,
            childRunId: call.childRunId,
          });
        }
      }
    }
    const projected = Result.try(() => {
      declaredStageTotal ??= snapshot.stages.length;
      if (!planEmitted) {
        planEmitted = true;
        // The plan is the snapshot's own stage and call lists, hydrated
        // history included. Hosts union it with the stages and cards that
        // follow, and a card always wins over its plan entry, so a resumed
        // run's plan never doubles what its cards already say.
        trace.emit({
          type: 'workflow.plan',
          attemptId: projectionId,
          stageId: parentStageId,
          phases: snapshot.stages.map((stage) => ({ title: stage.title })),
          // A resumed run's reusable results (completed or cached) are
          // history, not plan: they are never re-emitted as cards, so listing
          // them here would show finished work as declared.
          tasks: snapshot.calls
            .filter(
              (call) =>
                call.status !== WORKFLOW_CALL_STATUS.COMPLETED &&
                call.status !== WORKFLOW_CALL_STATUS.CACHED,
            )
            .map((call) => {
              const phase = stageTitleFor(snapshot, call);
              return {
                id: call.id,
                label: call.label,
                ...(phase !== undefined ? { phase } : {}),
              };
            }),
        });
      }
      for (const stage of snapshot.stages) {
        // A declared phase the run has not entered and whose calls are all
        // still plan labels is nothing to show: no header, no `Phase:` line.
        // A phase the run bypassed opens once the settle sweep terminalizes
        // the cards it owns, so their not-reached rows land under it.
        const state = deriveWorkflowStageState(snapshot, stage);
        if (!state.started) continue;
        const known = phases.has(stage.title);
        const phase = phaseFor(
          stage.title,
          stage.order,
          stage.order < declaredStageTotal ? declaredStageTotal : undefined,
        );
        if (!known) onActivity?.(`Phase: ${stage.title}`);
        if (state.outcome === RUN_OUTCOME.FAILED) phase.failed = true;
        if (state.current) currentPhase = stage.title;
      }
      for (const call of snapshot.calls) {
        const last = projectedCalls.get(call.id);
        // A retry re-queues a running call; the card follows it to `queued`
        // because that wait is real when another call took the freed slot.
        const { status } = call;
        const baseline = last ? undefined : hydratedBaseline.get(call.id);
        if (baseline !== undefined) {
          // A reset historical call is current only once `issueCall` stamps
          // this attempt's invocation facts on it, and `kind` is the one
          // every issued call carries — hydration restores none of them, so
          // admission cannot collapse when hydration and reissue share a
          // clock tick. Status alone would not do: the settle sweep
          // terminalizes a call this script never issued to `skipped`, and
          // that bookkeeping for the previous attempt stays silent here.
          if (baseline.status === WORKFLOW_CALL_STATUS.DECLARED) {
            if (call.kind === undefined) continue;
          } else if (
            baseline.status === status &&
            baseline.childRunId === call.childRunId
          ) {
            continue;
          }
          hydratedBaseline.delete(call.id);
        }
        // A declared card exists only under an open phase: a plan entry
        // behind a stage the run has never entered waits for its phase to
        // open (still waiting, or bypassed by a `phase()` jump that flipped
        // it straight to skipped), and a phase the run never reaches has its
        // entries swept to not-reached — emitted under the header the stage
        // loop above opens for them. A card whose group does not exist yet is
        // thereby unrepresentable.
        if (
          status === WORKFLOW_CALL_STATUS.DECLARED &&
          snapshot.stages.some(
            (stage) =>
              stage.id === call.stageId && stage.startedAt === undefined,
          )
        ) {
          continue;
        }
        const runChanged =
          call.childRunId !== undefined && last?.childRunId !== call.childRunId;
        // The host resolves agent and model after the card first appears;
        // a live card re-emits so it names what actually runs.
        const factsChanged =
          last !== undefined &&
          (last.agent !== call.agent || last.model !== call.model);
        if (last && last.status === status && !runChanged && !factsChanged) {
          continue;
        }
        const card = cardFor(call, snapshot);
        const previousStatus = last?.status;
        emitCall(card);
        if (status === previousStatus) continue;
        if (status === 'running') onActivity?.(`Running: ${call.label}`);
        if (status === 'cached') {
          onActivity?.(`Using saved result: ${call.label}`);
        }
        if (
          status === 'completed' ||
          status === 'failed' ||
          status === 'cancelled' ||
          status === 'skipped'
        ) {
          if (status === 'failed') markPhaseFailed(card.phase);
          recordTerminalActivity(card as WorkflowCallTerminalProgress);
        }
      }
      // Close a phase's stage once the run has left it and every call it
      // owns is terminal, so a finished phase reads finished (icon,
      // duration) while later phases still run, and a failure in phase 3
      // cannot retroactively mark phases 1-2. The failed card that flips a
      // phase is already emitted above. Once the run itself has ended,
      // `settle` closes whatever is still open with the run's own outcome:
      // a stage the script threw inside owns no failed call to derive one
      // from, and the throw is the run's fact, not the stage's.
      if (snapshot.outcome !== undefined) return;
      for (const stage of snapshot.stages) {
        const phase = phases.get(stage.title);
        const outcome = deriveWorkflowStageState(snapshot, stage).outcome;
        if (!phase || outcome === undefined) continue;
        phase.handle.end(phase.failed ? RUN_OUTCOME.FAILED : outcome);
      }
    });
    if (Result.isFailure(projected)) {
      const error = projected.failure;
      trace.warn(
        `Workflow progress projection failed for one transition: ${toErrorMessage(error)}`,
        { data: error },
      );
    }
  };

  const settle = (completed: boolean): void => {
    if (completed) runOutcome = RUN_OUTCOME.COMPLETED;
    if (lastSnapshot?.outcome === RUN_OUTCOME.CANCELLED) {
      runOutcome = RUN_OUTCOME.CANCELLED;
    }
    // The engine's `finish()` publishes its terminal snapshot synchronously
    // through the fold, so every card is normally terminal here. Fold the
    // terminal snapshot the writer landed once more — a no-op unless a
    // projection fault dropped a transition — then settle whatever is still
    // live as unfinished. A writer failure leaves `lastSnapshot` stale and
    // non-terminal; re-folding stale state could move a card backwards, so
    // only a terminal snapshot is re-folded.
    if (lastSnapshot?.outcome !== undefined) {
      fold(lastSnapshot);
    }
    closed = true;
    for (const card of projectedCalls.values()) {
      if (isTerminalWorkflowCallProgress(card)) continue;
      // Open the declared phase the run never reached so the settled card
      // still lands under a header; the loop below then closes it. The card
      // keeps every issued-call fact it already showed.
      openPhaseHandle(card.phase);
      markPhaseFailed(card.phase);
      const call: WorkflowCallTerminalProgress = {
        ...card,
        status: 'failed',
        error: WORKFLOW_CALL_UNFINISHED_NOTE,
      };
      emitCall(call);
      recordTerminalActivity(call);
    }
    for (const phase of phases.values()) {
      phase.handle.end(phase.failed ? RUN_OUTCOME.FAILED : runOutcome);
    }
  };
  return {
    options: {
      ...runOptions,
      onEvent: projectLog,
      onTransition: fold,
      onSnapshot: (snapshot) =>
        Effect.gen(function* () {
          lastSnapshot = snapshot;
          if (runOptions.onSnapshot) yield* runOptions.onSnapshot(snapshot);
        }),
    },
    settle,
  };
}
