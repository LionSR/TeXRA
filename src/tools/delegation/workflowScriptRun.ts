// Local imports - agent runtime
import type { AgentTrace, StageHandle } from '@agent/trace';
import {
  runPersistedWorkflowScript,
  type PersistedWorkflowScriptRunOptions,
  type WorkflowAgentInvocation,
  type WorkflowJournalEntry,
  type WorkflowScriptEvent,
  type WorkflowScriptRunResult,
} from '@agent/workflowScript';
import { AgentFinalResultSchema } from '@agent/runtime/AgentFinalResult';
import {
  isTerminalWorkflowCallStatus,
  RUN_OUTCOME,
  stageTitleFor,
  TERMINAL_WORKFLOW_CALL_STATUSES,
  WORKFLOW_CALL_STATUS,
  WORKFLOW_EXECUTION_LIFECYCLE,
  type RunOutcome,
  type WorkflowCallProgress,
  type WorkflowCallTerminalProgress,
  type WorkflowExecutionCall,
  type WorkflowExecutionSnapshot,
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
 * account of what happened read the canonical execution snapshot instead
 * (`onSnapshot` remains open and is composed, not replaced).
 */
type WorkflowScriptRunWithProgressOptions = Omit<
  PersistedWorkflowScriptRunOptions,
  'onEvent' | 'onTransition'
> & {
  /**
   * Receives every progress line also written to the trace (phases, script
   * log() output, per-call outcomes) so the caller can hand the run log back
   * to the invoking model, which otherwise cannot see any of it.
   */
  readonly onActivity?: (line: string) => void;
};

/**
 * Card status for one snapshot call. A plan stub the script has not issued is
 * `declared` whatever stage gate it sits behind; an issued call reports its
 * own queue/attempt state, so a host can show real concurrency (running vs.
 * queued) instead of one undifferentiated "planned".
 */
function projectWorkflowCallStatus(
  call: Pick<WorkflowExecutionCall, 'status' | 'issued'>,
): WorkflowCallProgress['status'] {
  switch (call.status) {
    case WORKFLOW_CALL_STATUS.PLANNED:
      return call.issued ? 'planned' : 'declared';
    case WORKFLOW_CALL_STATUS.STAGE_BLOCKED:
      return 'declared';
    case WORKFLOW_CALL_STATUS.AWAITING_APPROVAL:
      return 'awaitingApproval';
    case WORKFLOW_CALL_STATUS.QUEUED:
      return 'queued';
    case WORKFLOW_CALL_STATUS.RUNNING:
      return 'running';
    case WORKFLOW_CALL_STATUS.COMPLETED:
    case WORKFLOW_CALL_STATUS.CACHED:
    case WORKFLOW_CALL_STATUS.SKIPPED:
    case WORKFLOW_CALL_STATUS.FAILED:
    case WORKFLOW_CALL_STATUS.CANCELLED:
      return call.status;
  }
}

interface PhaseStage {
  readonly handle: StageHandle;
  failed: boolean;
}

interface ProjectedWorkflowCall {
  readonly logId: string;
  readonly definition: Pick<WorkflowCallProgress, 'id' | 'label' | 'phase'>;
  status: WorkflowCallProgress['status'];
  attemptNumber?: WorkflowCallProgress['attemptNumber'];
  childStreamId?: WorkflowCallProgress['childStreamId'];
  agent?: WorkflowCallProgress['agent'];
  model?: WorkflowCallProgress['model'];
}

function workflowJournalEntryCost(entry: WorkflowJournalEntry): number {
  const result = AgentFinalResultSchema.safeParse(entry.result);
  if (!result.success) {
    throw new Error(
      `Workflow journal entry ${entry.index} is not an agent final result.`,
      { cause: result.error },
    );
  }
  return result.data.cost;
}

type WorkflowAttemptIdentity = Pick<WorkflowAgentInvocation, 'index' | 'key'>;

/**
 * Keys are unique per run (the engine faults duplicates), so the key alone
 * identifies an attempt; a replayed entry re-journaled at a new index still
 * matches the attempt that produced it.
 */
function workflowAttemptIdentity(invocation: WorkflowAttemptIdentity): string {
  return invocation.key;
}

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
      const identity = workflowAttemptIdentity(invocation);
      const attempts = attemptsByIdentity.get(identity) ?? [];
      attempts.push(costUsd);
      attemptsByIdentity.set(identity, attempts);
      return observedTotalUsd;
    },
    total: (finalJournal) => {
      const journalIdentities = new Set<string>();
      let totalUsd = 0;
      for (const entry of finalJournal) {
        const identity = workflowAttemptIdentity(entry);
        journalIdentities.add(identity);
        const journalCostUsd = workflowJournalEntryCost(entry);
        const attempts = attemptsByIdentity.get(identity);
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
 * Run a durable workflow script and project its progress onto the parent trace.
 */
export async function runPersistedWorkflowScriptWithProgress(
  trace: AgentTrace,
  options: WorkflowScriptRunWithProgressOptions,
): Promise<WorkflowScriptRunResult> {
  const { onActivity, ...runOptions } = options;
  const parentStageId = trace.activeStageId();
  const phases = new Map<string, PhaseStage>();
  // A deterministic workflow stream appends every relaunch to one transcript.
  // Keep one card identity through this projection's state transitions without
  // colliding with the same logical call in an earlier attempt.
  const projectionId = generateShortId();
  const projectedCalls = new Map<
    WorkflowCallProgress['id'],
    ProjectedWorkflowCall
  >();
  // The engine terminalizes and flushes its snapshot before returning or
  // rethrowing, so the last one published is its final account of every call —
  // what the settle sweep below reads instead of re-deciding outcomes here.
  let lastSnapshot: WorkflowExecutionSnapshot | undefined;
  let currentPhase: string | undefined;
  let closed = false;
  // Calls that were already terminal when a retry's hydrated state first
  // emitted (see the fold): historical facts, projected only on change.
  const hydratedBaseline = new Map<
    WorkflowCallProgress['id'],
    {
      status: WorkflowCallProgress['status'];
      childStreamId: WorkflowCallProgress['childStreamId'];
    }
  >();
  let constructionEmissionSeen = false;
  let runOutcome: RunOutcome = RUN_OUTCOME.FAILED;

  const phaseFor = (
    title: string,
    index?: number,
    total?: number,
  ): PhaseStage => {
    const existing = phases.get(title);
    if (existing) return existing;
    const phase = {
      handle: trace.openStage(title, {
        kind: 'phase',
        parentId: parentStageId,
        index,
        total,
        attemptId: projectionId,
      }),
      failed: false,
    };
    phases.set(title, phase);
    return phase;
  };

  /**
   * Open a phase stage once the run reaches it and answer the stage rows
   * emitted from there belong to. Callers that only need the phase opened
   * ignore the return: `emitCall` resolves a card's group itself.
   */
  const openPhaseStage = (
    phase: string | undefined,
    index?: number,
    total?: number,
  ): string | undefined =>
    phase ? phaseFor(phase, index, total).handle.id : parentStageId;

  const recordTerminalActivity = (call: WorkflowCallTerminalProgress): void => {
    onActivity?.(formatWorkflowCallLine(call));
  };
  /**
   * The phase recorded on a call's first emission is the single owner of
   * "which phase is this call in", and it stamps both halves of that answer:
   * the `stageId` its card is grouped under, and the `phase` on the emitted
   * payload that hosts fold `done/total` by. A later update carrying the phase
   * active at call time never overrides it, so the group and the fold cannot
   * drift apart, and the same card cannot land in two groups — host progress
   * trees classify a card once and cannot move it afterwards.
   */
  const emitCall = (call: WorkflowCallProgress): void => {
    let projected = projectedCalls.get(call.id);
    if (!projected) {
      projected = {
        // Stable trace identity for this call within its run stream.
        logId: `workflow-task-${projectionId}-${call.id}`,
        definition: {
          id: call.id,
          label: call.label,
          ...(call.phase !== undefined ? { phase: call.phase } : {}),
        },
        status: call.status,
      };
      projectedCalls.set(call.id, projected);
    } else {
      projected.status = call.status;
    }
    if (call.childStreamId !== undefined) {
      projected.childStreamId = call.childStreamId;
    }
    projected.agent = call.agent;
    projected.model = call.model;
    if (call.attemptNumber === undefined) {
      delete projected.attemptNumber;
    } else {
      projected.attemptNumber = call.attemptNumber;
    }
    const phase = projected.definition.phase;
    // Cards are emitted only once the fold (or the settle sweep) has opened
    // their phase, so the group is the stage handle that already exists.
    trace.emit({
      type: 'workflow.call',
      logId: projected.logId,
      call: { ...call, phase, attemptId: projectionId },
      stageId: phase === undefined ? parentStageId : phaseFor(phase).handle.id,
    });
  };
  const markPhaseFailed = (
    title: string | undefined,
    index?: number,
    total?: number,
  ): void => {
    if (title) {
      phaseFor(title, index, total).failed = true;
    }
  };

  const projectLog = (event: WorkflowScriptEvent): void => {
    if (closed) return;
    trace.info(event.message, { stageId: openPhaseStage(currentPhase) });
    onActivity?.(event.message);
  };

  /** Progress-only terminal metadata, read off the snapshot's own record. */
  const terminalMetadata = (call: WorkflowExecutionCall) => {
    const model = call.model ?? call.attempts.at(-1)?.model;
    const { startedAt, completedAt } = call.timestamps;
    const durationMs =
      startedAt !== undefined && completedAt !== undefined
        ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
        : undefined;
    return {
      ...(model !== undefined && { model }),
      ...(durationMs !== undefined && { durationMs }),
      ...(call.costUsd !== undefined && { totalCostUsd: call.costUsd }),
    };
  };

  const cardFor = (
    call: WorkflowExecutionCall,
    status: WorkflowCallProgress['status'],
    snapshot: WorkflowExecutionSnapshot,
  ): WorkflowCallProgress => {
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
    const identity = {
      id: call.id,
      label: call.label,
      ...(phase !== undefined ? { phase } : {}),
      ...(call.childStreamId !== undefined
        ? { childStreamId: call.childStreamId }
        : {}),
      // The invocation facts a card carries once the script has issued the
      // call, read from the snapshot call — the one owner — so a declared stub
      // never looks like a resolved call.
      ...(call.issued && {
        ...(call.kind !== undefined && { kind: call.kind }),
        ...(call.agent !== undefined && { agent: call.agent }),
        ...(call.model !== undefined && { model: call.model }),
        files: call.files,
      }),
      ...(attemptCounts && { attemptNumber: call.attempts.length }),
    };
    switch (status) {
      case 'failed': {
        // A sweep-settled call never reached its own settlement: its card
        // carries spend but no model/duration, the same shape the settle
        // sweep emits.
        const spentOnly =
          call.costUsd !== undefined ? { totalCostUsd: call.costUsd } : {};
        return {
          ...identity,
          status,
          error: call.error ?? WORKFLOW_CALL_UNFINISHED_NOTE,
          ...(call.settledBySweep ? spentOnly : terminalMetadata(call)),
        };
      }
      case 'completed':
      case 'cancelled':
        return { ...identity, status, ...terminalMetadata(call) };
      case 'skipped':
        // The sweep settles not-reached plans; a user skip settles itself.
        return call.settledBySweep
          ? { ...identity, status, reason: 'not-reached' }
          : { ...identity, status, reason: 'user', ...terminalMetadata(call) };
      default:
        return { ...identity, status };
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
  const fold = (snapshot: WorkflowExecutionSnapshot): void => {
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
        const status = projectWorkflowCallStatus(call);
        if (
          isTerminalWorkflowCallStatus(status) ||
          call.attempts.length > 0 ||
          call.timestamps.createdAt !== call.timestamps.updatedAt
        ) {
          hydratedBaseline.set(call.id, {
            status,
            childStreamId: call.childStreamId,
          });
        }
      }
    }
    try {
      declaredStageTotal ??= snapshot.stages.length;
      for (const stage of snapshot.stages) {
        if (stage.lifecycle === 'waiting') continue;
        // A declared phase the run bypassed (`phase()` jumped past it, or the
        // script ended first) and that owns no card is nothing to show: no
        // header, no `Phase:` line. One that owns declared cards still opens
        // so their not-reached rows land under it.
        if (
          stage.lifecycle === 'skipped' &&
          stage.startedAt === undefined &&
          !snapshot.calls.some((call) => call.stageId === stage.id)
        ) {
          continue;
        }
        const known = phases.has(stage.title);
        const phase = phaseFor(
          stage.title,
          stage.order,
          stage.order < declaredStageTotal ? declaredStageTotal : undefined,
        );
        if (!known) onActivity?.(`Phase: ${stage.title}`);
        if (stage.lifecycle === 'failed') phase.failed = true;
        if (stage.lifecycle === 'active') currentPhase = stage.title;
      }
      for (const call of snapshot.calls) {
        const projected = projectedCalls.get(call.id);
        // A retry re-queues a running call; the card follows it to `queued`
        // because that wait is real when another call took the freed slot.
        const status = projectWorkflowCallStatus(call);
        const baseline = projected ? undefined : hydratedBaseline.get(call.id);
        if (baseline !== undefined) {
          // A reset historical call is current only once `issueCall` stamps
          // it issued by this attempt (hydration clears the stamp), which
          // cannot collapse when hydration and reissue share a clock tick.
          // Sweep-only terminalization of an omitted call therefore stays
          // silent.
          if (baseline.status === 'declared') {
            if (!call.issued) continue;
          } else if (
            baseline.status === status &&
            baseline.childStreamId === call.childStreamId
          ) {
            continue;
          }
          hydratedBaseline.delete(call.id);
        }
        // A declared card exists only under an open phase: the engine flips
        // stage-blocked plan entries to planned the moment their phase opens,
        // so the card is emitted then, and a phase the run never reaches has
        // its entries swept to not-reached — emitted under the header the
        // stage loop above opens for them. A card whose group does not exist
        // yet is thereby unrepresentable.
        if (call.status === WORKFLOW_CALL_STATUS.STAGE_BLOCKED) continue;
        const streamChanged =
          call.childStreamId !== undefined &&
          projected?.childStreamId !== call.childStreamId;
        // The host resolves agent and model after the card first appears;
        // a live card re-emits so it names what actually runs.
        const factsChanged =
          projected !== undefined &&
          (projected.agent !== call.agent || projected.model !== call.model);
        if (
          projected &&
          projected.status === status &&
          !streamChanged &&
          !factsChanged
        ) {
          continue;
        }
        const card = cardFor(call, status, snapshot);
        const previousStatus = projected?.status;
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
          if (status === 'failed') {
            // The phase recorded on the card's first emission owns which
            // group the failure marks.
            markPhaseFailed(
              projected
                ? projected.definition.phase
                : stageTitleFor(snapshot, call),
            );
          }
          recordTerminalActivity(card as WorkflowCallTerminalProgress);
        }
      }
      // Close a phase's stage when the engine has settled it, so a finished
      // phase reads finished (icon, duration) while later phases still run,
      // and a failure in phase 3 cannot retroactively mark phases 1-2. The
      // schema has no "exited but draining" lifecycle — `#settleStage` stamps
      // completed from call statuses while calls may still run — so close
      // only once every call of the stage is terminal; the failed card that
      // flips a phase is then already emitted above. `end` is idempotent, so
      // the finally sweep stays the backstop for stages the engine never
      // settled.
      for (const stage of snapshot.stages) {
        const phase = phases.get(stage.title);
        if (
          !phase ||
          stage.lifecycle === 'waiting' ||
          stage.lifecycle === 'active'
        ) {
          continue;
        }
        const drained = snapshot.calls.every(
          (call) =>
            call.stageId !== stage.id ||
            TERMINAL_WORKFLOW_CALL_STATUSES.has(call.status),
        );
        if (!drained) continue;
        let outcome: RunOutcome = RUN_OUTCOME.COMPLETED;
        if (phase.failed || stage.lifecycle === 'failed') {
          outcome = RUN_OUTCOME.FAILED;
        } else if (stage.lifecycle === 'cancelled') {
          outcome = RUN_OUTCOME.CANCELLED;
        }
        phase.handle.end(outcome);
      }
    } catch (error) {
      trace.warn(
        `Workflow progress projection failed for one transition: ${toErrorMessage(error)}`,
        { data: error },
      );
    }
  };

  // The physical attempt exists even when parsing or initial persistence fails
  // before the engine can emit a plan, phase, or call. Publish its boundary
  // first so live projections never infer the current run from optional work.
  trace.emit({ type: 'workflow.attempt', attemptId: projectionId });

  try {
    const result = await runPersistedWorkflowScript({
      ...runOptions,
      onEvent: projectLog,
      onTransition: fold,
      onSnapshot: async (snapshot) => {
        lastSnapshot = snapshot;
        await runOptions.onSnapshot?.(snapshot);
      },
    });
    runOutcome = RUN_OUTCOME.COMPLETED;
    return result;
  } finally {
    if (lastSnapshot?.lifecycle === WORKFLOW_EXECUTION_LIFECYCLE.CANCELLED) {
      runOutcome = RUN_OUTCOME.CANCELLED;
    }
    // The engine's `finish()` publishes its terminal snapshot synchronously
    // through the fold, so every card is normally terminal here. Fold the
    // terminal snapshot the writer landed once more — a no-op unless a
    // projection fault dropped a transition — then settle whatever is still
    // live as unfinished. A writer failure leaves `lastSnapshot` stale and
    // non-terminal; re-folding stale state could move a card backwards, so
    // only a terminal snapshot is re-folded.
    if (
      lastSnapshot !== undefined &&
      lastSnapshot.lifecycle !== WORKFLOW_EXECUTION_LIFECYCLE.WAITING &&
      lastSnapshot.lifecycle !== WORKFLOW_EXECUTION_LIFECYCLE.ACTIVE
    ) {
      fold(lastSnapshot);
    }
    closed = true;
    for (const projected of projectedCalls.values()) {
      if (isTerminalWorkflowCallStatus(projected.status)) continue;
      // Open the declared phase the run never reached so the settled card
      // still lands under a header; the loop below then closes it.
      openPhaseStage(projected.definition.phase);
      markPhaseFailed(projected.definition.phase);
      const call: WorkflowCallTerminalProgress = {
        ...projected.definition,
        ...(projected.attemptNumber !== undefined && {
          attemptNumber: projected.attemptNumber,
        }),
        ...(projected.childStreamId !== undefined && {
          childStreamId: projected.childStreamId,
        }),
        status: 'failed',
        error: WORKFLOW_CALL_UNFINISHED_NOTE,
      };
      emitCall(call);
      recordTerminalActivity(call);
    }
    for (const phase of phases.values()) {
      phase.handle.end(phase.failed ? RUN_OUTCOME.FAILED : runOutcome);
    }
  }
}
