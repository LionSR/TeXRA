// Local imports - agent runtime
import type { AgentTrace, StageHandle } from '@agent/trace';
import {
  runPersistedWorkflowScript,
  type PersistedWorkflowScriptRunOptions,
  type WorkflowAgentInvocation,
  type WorkflowJournalEntry,
  type WorkflowExecutionTransition,
  type WorkflowScriptEvent,
  type WorkflowScriptRunResult,
} from '@agent/workflowScript';
import { AgentFinalResultSchema } from '@agent/runtime/AgentFinalResult';
import {
  RUN_OUTCOME,
  WORKFLOW_CALL_STATUS,
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
import { assertNever, generateShortId } from '@utils/core';
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

interface PhaseStage {
  readonly handle: StageHandle;
  failed: boolean;
}

interface ProjectedWorkflowCall {
  readonly logId: string;
  readonly definition: Pick<WorkflowCallProgress, 'id' | 'label' | 'phase'>;
  status: WorkflowCallProgress['status'];
  childStreamId?: WorkflowCallProgress['childStreamId'];
}

export class WorkflowJournalCostError extends Error {
  constructor(index: number, options?: ErrorOptions) {
    super(
      `Workflow journal entry ${index} is not an agent final result.`,
      options,
    );
    this.name = 'WorkflowJournalCostError';
  }
}

function workflowJournalEntryCost(entry: WorkflowJournalEntry): number {
  const result = AgentFinalResultSchema.safeParse(entry.result);
  if (!result.success) {
    throw new WorkflowJournalCostError(entry.index, {
      cause: result.error,
    });
  }
  return result.data.cost;
}

type WorkflowAttemptIdentity = Pick<WorkflowAgentInvocation, 'index' | 'key'>;

function workflowAttemptIdentity(invocation: WorkflowAttemptIdentity): string {
  return `${invocation.index}:${invocation.key}`;
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
 * index+key identity. The production child runner emits exactly one callback for every
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
 * One terminal card for a call this projection last saw live, restating what the
 * engine's own `finish()` decided that call became. The snapshot is the single
 * authority for the outcome — status, error, and spend — while the card keeps
 * the identity this projection already recorded, so settling can never rename a
 * card or move it between phase groups.
 */
function settledWorkflowCall(
  projected: ProjectedWorkflowCall,
  settled: WorkflowExecutionCall | undefined,
): WorkflowCallTerminalProgress {
  const identity = {
    ...projected.definition,
    ...(projected.childStreamId !== undefined && {
      childStreamId: projected.childStreamId,
    }),
  };
  const spent =
    settled?.costUsd === undefined ? {} : { totalCostUsd: settled.costUsd };
  switch (settled?.status) {
    case WORKFLOW_CALL_STATUS.COMPLETED:
      return { ...identity, status: 'completed', ...spent };
    case WORKFLOW_CALL_STATUS.CACHED:
      return { ...identity, status: 'cached' };
    case WORKFLOW_CALL_STATUS.SKIPPED:
      // The sweep settles not-reached plans; a user skip settles itself.
      return settled.settledBySweep
        ? { ...identity, status: 'skipped', reason: 'not-reached' }
        : { ...identity, status: 'skipped', reason: 'user', ...spent };
    default:
      // Failed, cancelled (the card vocabulary has no cancelled outcome), and
      // the non-terminal states left behind when the snapshot could not be
      // persisted at all.
      return {
        ...identity,
        status: 'failed',
        error: settled?.error ?? WORKFLOW_CALL_UNFINISHED_NOTE,
        ...spent,
      };
  }
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
  const phaseStageIds = new Map<string, string>();
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

  /**
   * Stable stage id for a phase title, minted before the stage opens. A
   * declared task can name the group it belongs to from the moment it is
   * planned, while `stage.start` — which settles the divider's print order the
   * instant it is emitted — still waits until the run actually reaches the
   * phase, so a divider never prints above its own task rows.
   */
  const phaseStageIdFor = (title: string): string => {
    const existing = phaseStageIds.get(title);
    if (existing) return existing;
    const id = generateShortId();
    phaseStageIds.set(title, id);
    return id;
  };

  const phaseFor = (
    title: string,
    index?: number,
    total?: number,
  ): PhaseStage => {
    const existing = phases.get(title);
    if (existing) return existing;
    const phase = {
      handle: trace.openStage(title, {
        id: phaseStageIdFor(title),
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
    const phase = projected.definition.phase;
    trace.emit({
      type: 'workflow.call',
      logId: projected.logId,
      call: { ...call, phase, attemptId: projectionId },
      stageId: phase === undefined ? parentStageId : phaseStageIdFor(phase),
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

  const cardStatusFor = (
    status: WorkflowExecutionCall['status'],
  ): WorkflowCallProgress['status'] => {
    switch (status) {
      case WORKFLOW_CALL_STATUS.PLANNED:
      case WORKFLOW_CALL_STATUS.STAGE_BLOCKED:
      case WORKFLOW_CALL_STATUS.QUEUED:
        return 'planned';
      case WORKFLOW_CALL_STATUS.STARTING:
      case WORKFLOW_CALL_STATUS.RUNNING:
        return 'running';
      case WORKFLOW_CALL_STATUS.COMPLETED:
        return 'completed';
      case WORKFLOW_CALL_STATUS.CACHED:
        return 'cached';
      case WORKFLOW_CALL_STATUS.SKIPPED:
        return 'skipped';
      case WORKFLOW_CALL_STATUS.FAILED:
      case WORKFLOW_CALL_STATUS.CANCELLED:
        // The card vocabulary has no cancelled outcome.
        return 'failed';
      default:
        return assertNever(status, 'Unhandled workflow call status');
    }
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
  ): WorkflowCallProgress => {
    const identity = {
      id: call.id,
      label: call.label,
      ...(call.stageTitle !== undefined ? { phase: call.stageTitle } : {}),
      ...(call.childStreamId !== undefined
        ? { childStreamId: call.childStreamId }
        : {}),
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
  const fold = (
    snapshot: WorkflowExecutionSnapshot,
    transition?: WorkflowExecutionTransition,
  ): void => {
    if (closed) return;
    try {
      declaredStageTotal ??= snapshot.stages.length;
      for (const stage of snapshot.stages) {
        if (stage.lifecycle === 'waiting') continue;
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
        let status = cardStatusFor(call.status);
        // A retry re-queues a running call; keep its card running rather than
        // flickering back to planned (the old start-latch behavior).
        if (status === 'planned' && projected?.status === 'running') {
          status = 'running';
        }
        // A call carried into the construction emission is hydrated history,
        // not this attempt's activity. Reusable calls are terminal here;
        // failed/cancelled calls were reset to planned, but retain an earlier
        // creation timestamp or attempt record. Record either shape silently.
        // Emitting a hydrated dynamic call would freeze the identity before
        // `issueCall` restores its phase, and a call absent from this script
        // would appear as current-attempt not-reached work.
        const hydratedHistory =
          status === 'completed' ||
          status === 'failed' ||
          status === 'skipped' ||
          status === 'cached' ||
          call.attempts.length > 0 ||
          call.timestamps.createdAt !== call.timestamps.updatedAt;
        if (!constructionEmissionSeen && !projected && hydratedHistory) {
          hydratedBaseline.set(call.id, {
            status,
            childStreamId: call.childStreamId,
          });
          continue;
        }
        const baseline = projected ? undefined : hydratedBaseline.get(call.id);
        if (baseline !== undefined) {
          // A reset historical call is current only after issueCall explicitly
          // identifies it as issued by this attempt. This cannot collapse when
          // hydration and reissue occur within the same clock tick. Sweep-only
          // terminalization of an omitted call therefore stays silent.
          if (baseline.status === 'planned') {
            const reissued =
              transition?.type === 'call-issued' &&
              transition.callId === call.id;
            if (!reissued) continue;
          } else if (
            baseline.status === status &&
            baseline.childStreamId === call.childStreamId
          ) {
            continue;
          }
          hydratedBaseline.delete(call.id);
        }
        const streamChanged =
          call.childStreamId !== undefined &&
          projected?.childStreamId !== call.childStreamId;
        if (projected && projected.status === status && !streamChanged) {
          continue;
        }
        // No stage open here: `emitCall` groups a card by its minted stage id,
        // and the stage itself opens (with its declared position) when the
        // stage loop above sees the run enter it — planned cards must not
        // open their phase early.
        const card = cardFor(call, status);
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
          status === 'skipped'
        ) {
          if (status === 'failed') {
            // The phase recorded on the card's first emission owns which
            // group the failure marks.
            markPhaseFailed(
              projected ? projected.definition.phase : call.stageTitle,
            );
          }
          recordTerminalActivity(card as WorkflowCallTerminalProgress);
        }
      }
      constructionEmissionSeen = true;
    } catch (error) {
      constructionEmissionSeen = true;
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
    closed = true;
    const settledById = new Map(
      (lastSnapshot?.calls ?? []).map((call) => [call.id, call]),
    );
    for (const projected of projectedCalls.values()) {
      if (projected.status !== 'planned' && projected.status !== 'running') {
        continue;
      }
      // Open the declared phase the run never reached so its settled cards
      // still land under a header; the loop below then closes it.
      openPhaseStage(projected.definition.phase);
      const call = settledWorkflowCall(
        projected,
        settledById.get(projected.definition.id),
      );
      if (call.status === 'failed') markPhaseFailed(projected.definition.phase);
      emitCall(call);
      recordTerminalActivity(call);
    }
    for (const phase of phases.values()) {
      phase.handle.end(
        runOutcome === RUN_OUTCOME.COMPLETED && !phase.failed
          ? RUN_OUTCOME.COMPLETED
          : RUN_OUTCOME.FAILED,
      );
    }
  }
}
