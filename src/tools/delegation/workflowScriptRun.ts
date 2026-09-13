import { Cause, Exit } from 'effect';

// Local imports - agent runtime
import type { AgentTrace, StageHandle } from '@agent/trace';
import type { PersistedWorkflowScriptRunOptions } from '@agent/workflowScript/checkpoint';
import type {
  WorkflowAgentInvocation,
  WorkflowJournalEntry,
  WorkflowScriptEvent,
} from '@agent/workflowScript/types';
import {
  isTerminalWorkflowCallProgress,
  RUN_OUTCOME,
  RunEndSchema,
  type RunOutcome,
  type WorkflowCallProgress,
} from '@shared/schemas';
import { formatWorkflowCallLine } from '@shared/copy/workflowCall';
import { generateShortId } from '@utils/core';

/**
 * `onEvent` is omitted deliberately: this projection owns the engine's event
 * slot outright, so a caller cannot pass a handler that would be silently
 * discarded. What the run did is read back off the cards through `board`.
 */
type WorkflowScriptRunWithProgressOptions<R> = Omit<
  PersistedWorkflowScriptRunOptions<R>,
  'onEvent'
> & {
  /**
   * Receives every progress line also written to the trace (phases, script
   * log() output, per-call outcomes) so the caller can hand the run log back
   * to the invoking model, which otherwise cannot see any of it.
   */
  readonly onActivity?: (line: string) => void;
};

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
 * trace: the run options with the engine's event slot bound, the settle step
 * the caller runs once the run has ended either way, and the board the cards
 * add up to.
 */
export interface WorkflowScriptProgressProjection<R> {
  readonly options: PersistedWorkflowScriptRunOptions<R>;
  /** Close every phase the run left open; `exit` is how the run ended. */
  readonly settle: (exit: Exit.Exit<unknown, unknown>) => void;
  /** Every phase the run declared or entered, and the latest card per call —
   *  the same cards the boards paint, for the delivery tally. */
  readonly board: () => {
    readonly phaseCount: number;
    readonly calls: readonly WorkflowCallProgress[];
  };
}

/**
 * Project a durable workflow script's progress onto the parent trace: each
 * engine event becomes the row it is (`workflow.plan`, `stage.start`,
 * `stage.end`, `workflow.call`), stamped with this attempt's id. The caller
 * runs `options` through `runPersistedWorkflowScript` and calls `settle` in
 * a finalizer.
 */
export function projectWorkflowScriptProgress<R>(
  trace: AgentTrace,
  options: WorkflowScriptRunWithProgressOptions<R>,
): WorkflowScriptProgressProjection<R> {
  const { onActivity, ...runOptions } = options;
  const parentStageId = trace.activeStageId();
  const phases = new Map<string, StageHandle>();
  const phaseTitles = new Set<string>();
  // A deterministic workflow stream appends every relaunch to one transcript.
  // Keep one card identity through this projection's state transitions without
  // colliding with the same logical call in an earlier attempt.
  const projectionId = generateShortId();
  const cards = new Map<WorkflowCallProgress['id'], WorkflowCallProgress>();
  let currentPhase: string | undefined;

  const phaseFor = (
    title: string,
    index?: number,
    total?: number,
  ): StageHandle => {
    const existing = phases.get(title);
    if (existing) return existing;
    const handle = trace.openStage(title, {
      kind: 'phase',
      parentId: parentStageId,
      index,
      total,
    });
    phases.set(title, handle);
    return handle;
  };

  /**
   * Open a phase stage once the run reaches it and answer the stage rows
   * emitted from there belong to. A not-reached card still opens the declared
   * phase it sits under, so its row lands beneath that header.
   */
  const openPhaseHandle = (phase: string | undefined): string | undefined =>
    phase ? phaseFor(phase).id : parentStageId;

  /**
   * A card's `phase` is the engine's own record: pinned when the call is
   * issued, and a declared task issued elsewhere is a contract fault, so the
   * phase on the card and the group it is emitted under are one fact.
   */
  const emitCall = (call: WorkflowCallProgress): void => {
    const card: WorkflowCallProgress = { ...call, attemptId: projectionId };
    cards.set(call.id, card);
    trace.emit({
      type: 'workflow.call',
      // Stable trace identity for this call within its run stream.
      logId: `workflow-task-${projectionId}-${call.id}`,
      call: card,
      stageId: openPhaseHandle(card.phase),
    });
  };

  const onEvent = (event: WorkflowScriptEvent): void => {
    switch (event.type) {
      case 'log':
        trace.info(event.message, { stageId: openPhaseHandle(currentPhase) });
        onActivity?.(event.message);
        return;
      case 'plan':
        for (const phase of event.plan.phases) phaseTitles.add(phase.title);
        // Hosts union the plan with the stages and cards that follow, and a
        // card always wins over its plan entry, so nothing is listed twice.
        trace.emit({
          type: 'workflow.plan',
          attemptId: projectionId,
          stageId: parentStageId,
          phases: event.plan.phases,
          tasks: event.plan.tasks,
        });
        return;
      case 'phase.open': {
        phaseTitles.add(event.title);
        const known = phases.has(event.title);
        phaseFor(event.title, event.index, event.total);
        if (!known) onActivity?.(`Phase: ${event.title}`);
        currentPhase = event.title;
        return;
      }
      case 'phase.close':
        phases.get(event.title)?.end(event.outcome);
        return;
      case 'call': {
        const { call } = event;
        const previous = cards.get(call.id)?.status;
        emitCall(call);
        if (call.status === previous) return;
        if (call.status === 'running') onActivity?.(`Running: ${call.label}`);
        if (call.status === 'cached') {
          onActivity?.(`Using saved result: ${call.label}`);
        }
        if (isTerminalWorkflowCallProgress(call)) {
          onActivity?.(formatWorkflowCallLine(call));
        }
        return;
      }
      default:
        return event satisfies never;
    }
  };

  // The engine's own sweep closes every stage it announced before it returns
  // or rethrows; this covers a fault that stopped it short of that. The
  // outcome is read the way the engine's `finalize` reads it: a run stopped
  // by interruption alone or by its abort signal was cancelled, not failed,
  // matching the `finish(CANCELLED)` sweep the fault pre-empted.
  const settle = (exit: Exit.Exit<unknown, unknown>): void => {
    let outcome: RunOutcome = RUN_OUTCOME.FAILED;
    if (Exit.isSuccess(exit)) {
      outcome = RUN_OUTCOME.COMPLETED;
    } else if (
      Cause.hasInterruptsOnly(exit.cause) ||
      runOptions.signal?.aborted === true
    ) {
      outcome = RUN_OUTCOME.CANCELLED;
    }
    for (const handle of phases.values()) {
      handle.end(outcome);
    }
  };
  return {
    options: { ...runOptions, onEvent },
    settle,
    board: () => ({ phaseCount: phaseTitles.size, calls: [...cards.values()] }),
  };
}
