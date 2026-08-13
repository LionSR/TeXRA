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

/**
 * `onEvent` is omitted deliberately: this projection owns the engine's event
 * slot outright, so a caller cannot pass a handler that would be silently
 * discarded. Callers that need the run's own account of what happened read the
 * canonical execution snapshot instead.
 */
type WorkflowScriptRunWithProgressOptions = Omit<
  PersistedWorkflowScriptRunOptions,
  'onEvent'
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
      // `finish()` stamps the not-reached note; a user skip carries none.
      return settled.blockedReason === undefined
        ? { ...identity, status: 'skipped', reason: 'user', ...spent }
        : { ...identity, status: 'skipped', reason: 'not-reached' };
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

  const project = (event: WorkflowScriptEvent): void => {
    if (closed) return;
    switch (event.type) {
      case 'plan':
        for (const task of event.tasks) {
          emitCall({ ...task, status: 'planned' });
        }
        break;
      case 'phase':
        currentPhase = event.title;
        phaseFor(event.title, event.index, event.total);
        onActivity?.(`Phase: ${event.title}`);
        break;
      case 'log':
        trace.info(event.message, { stageId: openPhaseStage(currentPhase) });
        onActivity?.(event.message);
        break;
      case 'agent:start': {
        // The engine stamps a call's phase once, at issuance, and repeats it on
        // every event for that call, so the event is the only phase source this
        // projection needs.
        openPhaseStage(event.phase, event.phaseIndex, event.phaseTotal);
        emitCall({
          id: event.progressId,
          label: event.label,
          ...(event.phase !== undefined ? { phase: event.phase } : {}),
          status: 'running',
          ...(event.childStreamId !== undefined
            ? { childStreamId: event.childStreamId }
            : {}),
        });
        onActivity?.(`Running: ${event.label}`);
        break;
      }
      case 'agent:stream': {
        emitCall({
          id: event.progressId,
          label: event.label,
          ...(event.phase !== undefined ? { phase: event.phase } : {}),
          status: 'running',
          childStreamId: event.childStreamId,
        });
        break;
      }
      case 'agent:end': {
        // A cached replay has no agent:start, so this is where its phase opens.
        openPhaseStage(event.phase, event.phaseIndex, event.phaseTotal);
        const identity = {
          id: event.progressId,
          label: event.label,
          ...(event.phase !== undefined ? { phase: event.phase } : {}),
          ...(event.childStreamId !== undefined
            ? { childStreamId: event.childStreamId }
            : {}),
        };
        // Cached replays belong to the current projection attempt, but perform
        // no live agent call and therefore carry no duration or cost metadata.
        if (event.outcome === 'cached') {
          emitCall({ ...identity, status: 'cached' });
          onActivity?.(`Using saved result: ${event.label}`);
          break;
        }
        const metadata = {
          ...(event.model !== undefined ? { model: event.model } : {}),
          ...(event.durationMs !== undefined
            ? { durationMs: event.durationMs }
            : {}),
          ...(event.costUsd !== undefined
            ? { totalCostUsd: event.costUsd }
            : {}),
        };
        let call: WorkflowCallProgress;
        switch (event.outcome) {
          case 'failed': {
            call = {
              ...identity,
              status: 'failed',
              error: event.error,
              ...metadata,
            };
            // The phase recorded on the card's first emission owns which group
            // the failure marks; fall back to this event's own phase only for a
            // call that was never emitted.
            const projected = projectedCalls.get(call.id);
            markPhaseFailed(
              projected ? projected.definition.phase : call.phase,
              event.phaseIndex,
              event.phaseTotal,
            );
            break;
          }
          case 'skipped':
            call = {
              ...identity,
              status: 'skipped',
              reason: event.reason,
              ...metadata,
            };
            break;
          case 'completed':
            call = { ...identity, status: 'completed', ...metadata };
            break;
          default:
            return assertNever(event, 'Unhandled agent:end outcome');
        }
        emitCall(call);
        recordTerminalActivity(call);
        break;
      }
    }
  };

  // The physical attempt exists even when parsing or initial persistence fails
  // before the engine can emit a plan, phase, or call. Publish its boundary
  // first so live projections never infer the current run from optional work.
  trace.emit({ type: 'workflow.attempt', attemptId: projectionId });

  try {
    const result = await runPersistedWorkflowScript({
      ...runOptions,
      onEvent: project,
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
