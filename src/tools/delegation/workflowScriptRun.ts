// Local imports - agent runtime
import type { AgentTrace, StageHandle } from '@agent/trace';
import {
  runPersistedWorkflowScript,
  type PersistedWorkflowScriptRunOptions,
  type WorkflowAgentInvocation,
  type WorkflowJournalEntry,
  type WorkflowScriptEvent,
  type WorkflowScriptProgressId,
  type WorkflowScriptRunResult,
} from '@agent/workflowScript';
import { AgentFinalResultSchema } from '@agent/runtime/AgentFinalResult';
import {
  RUN_OUTCOME,
  type RunOutcome,
  type WorkflowCallProgress,
} from '@shared/schemas';
import { formatWorkflowCallLine } from '@shared/copy/workflowCall';
import { assertNever, generateShortId } from '@utils/core';

type WorkflowScriptRunWithProgressOptions = Omit<
  PersistedWorkflowScriptRunOptions,
  'onEvent'
> & {
  /** Accumulated live spend for one logical call, for progress lines. */
  readonly getCallCostUsd?: (index: number) => number | undefined;
  /**
   * Receives every progress line also written to the trace (phases, script
   * log() output, per-call outcomes) so the caller can hand the run log back
   * to the invoking model, which otherwise cannot see any of it.
   */
  readonly onActivity?: (line: string) => void;
  /**
   * Receives the run fold's fact-snapshot accessor synchronously, before the
   * engine starts, so a caller settling after a throw still reads the final
   * fold. The snapshot is meaningful once the run has settled.
   */
  readonly onRunFacts?: (snapshot: () => WorkflowScriptRunFacts) => void;
};

/**
 * Terminal per-call facts folded from one run's event stream.
 * `runPersistedWorkflowScriptWithProgress` is the single state machine over
 * `WorkflowScriptEvent`; the run log and the delivery summary derive from
 * this fold rather than re-folding the events themselves.
 */
export interface WorkflowScriptRunFacts {
  /** Outcome per call id, in first-emission order. */
  readonly callOutcomes: ReadonlyMap<
    WorkflowScriptProgressId,
    WorkflowCallProgress['status']
  >;
  /** Distinct phase titles the run announced with phase events. */
  readonly announcedPhaseCount: number;
  /** Task count the plan event declared; 0 when the run never planned. */
  readonly declaredTaskCount: number;
}

/** The fold's state before any run event reaches it. */
export const EMPTY_WORKFLOW_SCRIPT_RUN_FACTS: WorkflowScriptRunFacts = {
  callOutcomes: new Map(),
  announcedPhaseCount: 0,
  declaredTaskCount: 0,
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

/** Stable trace identity for one workflow call within its run stream. */
function workflowCallLogId(
  projectionId: string,
  id: WorkflowScriptProgressId,
): string {
  return `workflow-task-${projectionId}-${id}`;
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

export interface WorkflowAttemptCostTracker {
  /** Record one physical child attempt and return this tool invocation's live total. */
  record(invocation: WorkflowAttemptIdentity, costUsd: number): number;
  /**
   * Live cost observed so far for one engine call index (every attempt of
   * every key at that index), or `undefined` when that index has emitted no
   * attempt yet. Feeds {@link WorkflowScriptRunWithProgressOptions.getCallCostUsd}.
   */
  costForCall(index: number): number | undefined;
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
  const costByCallIndex = new Map<number, number>();
  let observedTotalUsd = 0;

  return {
    record: (invocation, costUsd) => {
      observedTotalUsd += costUsd;
      const identity = workflowAttemptIdentity(invocation);
      const attempts = attemptsByIdentity.get(identity) ?? [];
      attempts.push(costUsd);
      attemptsByIdentity.set(identity, attempts);
      costByCallIndex.set(
        invocation.index,
        (costByCallIndex.get(invocation.index) ?? 0) + costUsd,
      );
      return observedTotalUsd;
    },
    costForCall: (index) => costByCallIndex.get(index),
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
 * Run a durable workflow script and project its progress onto the parent
 * trace. This is the single fold over the run's `WorkflowScriptEvent` stream:
 * the trace cards, the `onActivity` run-log lines, and the `onRunFacts`
 * terminal per-call facts all derive from the one projection state below.
 */
export async function runPersistedWorkflowScriptWithProgress(
  trace: AgentTrace,
  options: WorkflowScriptRunWithProgressOptions,
): Promise<WorkflowScriptRunResult> {
  const { getCallCostUsd, onActivity, onRunFacts, ...runOptions } = options;
  const parentStageId = trace.activeStageId();
  const phases = new Map<string, PhaseStage>();
  const phaseStageIds = new Map<string, string>();
  // A deterministic workflow stream appends every relaunch to one transcript.
  // Keep one card identity through this projection's state transitions without
  // colliding with the same logical call in an earlier attempt.
  const projectionId = generateShortId();
  const callPhases = new Map<WorkflowScriptProgressId, string | undefined>();
  const callIndexes = new Map<WorkflowScriptProgressId, number>();
  const projectedCalls = new Map<
    WorkflowScriptProgressId,
    ProjectedWorkflowCall
  >();
  const announcedPhaseTitles = new Set<string>();
  let declaredTaskCount = 0;
  let currentPhase: string | undefined;
  let closed = false;
  let runOutcome: RunOutcome = RUN_OUTCOME.FAILED;

  onRunFacts?.(() => ({
    callOutcomes: new Map(
      [...projectedCalls].map(([id, call]) => [id, call.status]),
    ),
    announcedPhaseCount: announcedPhaseTitles.size,
    declaredTaskCount,
  }));

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

  const info = (message: string, stageId: string | undefined): void => {
    trace.info(message, { stageId });
    onActivity?.(message);
  };
  const recordTerminalActivity = (
    call: Extract<
      WorkflowCallProgress,
      { readonly status: 'completed' | 'failed' | 'skipped' }
    >,
  ): void => {
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
        logId: workflowCallLogId(projectionId, call.id),
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
      call: { ...call, phase },
      stageId: phase === undefined ? parentStageId : phaseStageIdFor(phase),
    });
  };
  const recordedCallPhase = (
    call: Pick<WorkflowCallProgress, 'id' | 'phase'>,
  ): string | undefined => {
    const projected = projectedCalls.get(call.id);
    return projected ? projected.definition.phase : call.phase;
  };
  /**
   * A recorded undefined means the live call started outside any phase; only
   * cached end-only events may use the phase active at replay time.
   */
  const liveCallPhase = (event: {
    readonly progressId: WorkflowScriptProgressId;
    readonly phase?: string;
  }): string | undefined =>
    callPhases.has(event.progressId)
      ? callPhases.get(event.progressId)
      : (event.phase ?? currentPhase);
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
        declaredTaskCount = event.tasks.length;
        for (const task of event.tasks) {
          emitCall({ ...task, status: 'planned' });
        }
        break;
      case 'phase':
        currentPhase = event.title;
        announcedPhaseTitles.add(event.title);
        phaseFor(event.title, event.index, event.total);
        onActivity?.(`Phase: ${event.title}`);
        break;
      case 'log':
        info(event.message, openPhaseStage(currentPhase));
        break;
      case 'agent:queued':
        break;
      case 'agent:start': {
        const phaseTitle = event.phase ?? currentPhase;
        callPhases.set(event.progressId, phaseTitle);
        callIndexes.set(event.progressId, event.index);
        // Open the phase the moment the run reaches it; `emitCall` resolves
        // the card's group on its own from the task's recorded phase.
        openPhaseStage(phaseTitle, event.phaseIndex, event.phaseTotal);
        emitCall({
          id: event.progressId,
          label: event.label,
          ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
          status: 'running',
          ...(event.childStreamId !== undefined
            ? { childStreamId: event.childStreamId }
            : {}),
        });
        onActivity?.(`Running: ${event.label}`);
        break;
      }
      case 'agent:stream': {
        const phaseTitle = liveCallPhase(event);
        emitCall({
          id: event.progressId,
          label: event.label,
          ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
          status: 'running',
          childStreamId: event.childStreamId,
        });
        break;
      }
      case 'agent:end': {
        const phaseTitle = liveCallPhase(event);
        callPhases.delete(event.progressId);
        callIndexes.delete(event.progressId);
        // A cached replay has no agent:start, so this is where its phase opens.
        openPhaseStage(phaseTitle, event.phaseIndex, event.phaseTotal);
        const identity = {
          id: event.progressId,
          label: event.label,
          ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
          ...(event.childStreamId !== undefined
            ? { childStreamId: event.childStreamId }
            : {}),
        };
        // Cached replays perform no live attempt, so they carry neither
        // attempt metadata nor cost.
        if (event.outcome === 'cached') {
          emitCall({ ...identity, status: 'cached' });
          onActivity?.(`Using saved result: ${event.label}`);
          break;
        }
        // Live onCost settles before agent:end, so the call cost here is
        // current, as is the rest of the attempt metadata the engine knows.
        const spent = getCallCostUsd?.(event.index);
        const metadata = {
          ...(event.model !== undefined ? { model: event.model } : {}),
          ...(event.durationMs !== undefined
            ? { durationMs: event.durationMs }
            : {}),
          ...(spent !== undefined ? { totalCostUsd: spent } : {}),
        };
        let call: WorkflowCallProgress;
        switch (event.outcome) {
          case 'failed':
            call = {
              ...identity,
              status: 'failed',
              error: event.error,
              ...metadata,
            };
            markPhaseFailed(
              recordedCallPhase(call),
              event.phaseIndex,
              event.phaseTotal,
            );
            break;
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

  try {
    const result = await runPersistedWorkflowScript({
      ...runOptions,
      onEvent: project,
    });
    runOutcome = RUN_OUTCOME.COMPLETED;
    return result;
  } finally {
    closed = true;
    for (const {
      definition: call,
      status,
      childStreamId,
    } of projectedCalls.values()) {
      if (status === 'planned') {
        // Open the declared phase the run never reached so its skipped cards
        // still land under a header; the loop below then closes it.
        openPhaseStage(call.phase);
        const skippedCall: WorkflowCallProgress = {
          ...call,
          status: 'skipped',
          reason: 'not-reached',
        };
        emitCall(skippedCall);
        recordTerminalActivity(skippedCall);
      } else if (status === 'running') {
        markPhaseFailed(call.phase);
        const error = 'The workflow ended before this call completed.';
        const callIndex = callIndexes.get(call.id);
        const totalCostUsd =
          callIndex === undefined ? undefined : getCallCostUsd?.(callIndex);
        const failedCall: WorkflowCallProgress = {
          ...call,
          status: 'failed',
          error,
          ...(childStreamId !== undefined ? { childStreamId } : {}),
          ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
        };
        emitCall(failedCall);
        recordTerminalActivity(failedCall);
      }
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
