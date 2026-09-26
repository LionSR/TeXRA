/**
 * Run lifecycle operations.
 *
 * Business logic that orchestrates the run's records across its aggregate:
 * registration, activation and finalization, separate from the record
 * accessors in `runRecords.ts`.
 */

import { Cause, Data, Effect, Exit } from 'effect';

import {
  isAgentRunRecord,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import type { SessionHandle } from '@agent/runtime/SessionHandle';

import {
  AgentCategory,
  aggregateId,
  type SessionEventDraft,
  USER_FOLLOW_UP_SUPPORT,
  emptyRunEndOutput,
  type RunEnd,
  type RunEndOutput,
  type RunId,
  type RunIdentity,
  type RunOutcome,
  type SessionEvent,
  type UserFollowUpSupport,
} from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { getRunRecords, runEndFromEvents } from './runRecords';

function pinRunWorkingDirectory(
  record: RunRecord,
  workspaceRoot: string | undefined,
): RunRecord {
  // First non-blank candidate wins, stored verbatim (untrimmed) — trimming
  // here previously mangled resumed workflow paths (2e3197f92f).
  const workingDirectory = [record.workingDirectory, workspaceRoot].find(
    (dir) => dir?.trim(),
  );
  return workingDirectory ? { ...record, workingDirectory } : record;
}

interface RegisterRunOptions {
  /** The launching run: the whole parent edge, stamped on `run.start`. */
  readonly parentRunId?: RunId;
  readonly checkpointId?: string;
  readonly category?: AgentCategory;
  /** The run's identity, declared by the launch site — the durable authority. */
  readonly identity: RunIdentity;
  /** Runtime behavior declared by the launch source, not UI visibility. */
  readonly userFollowUpSupport?: UserFollowUpSupport;
  /**
   * The run's `run.description` row, written in the registration batch so it
   * is durable at birth (#9590 A4): child launchers pass the delegated task
   * label; a root run gets its AI-generated summary from
   * `generateSessionDescription` later, as a second row of the same type.
   */
  readonly description?: string;
}

/**
 * Register a new run: persist config, metadata, and parent linkage.
 * Awaits all writes before returning.
 */
export const registerRun = Effect.fn('registerRun')(function* (
  session: SessionHandle,
  runId: RunId,
  record: RunRecord,
  options: RegisterRunOptions,
): Effect.fn.Return<void, Error> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const prior = yield* getRunRecords(session, runId).exists();
      // A re-registration writes into a run that already has rows, so it
      // takes the run's claim for itself: a hold for this registration
      // only. The run's driver takes its own hold for the run's life.
      if (prior) yield* session.holdRunClaim(runId);
      if (options.parentRunId !== undefined) {
        // A record read goes straight to the database; it never queues behind
        // the publisher. A parent whose `run.start` is queued but uncommitted
        // therefore reads as absent here, and the refusal below would be about
        // a parent that is on its way in. This empty batch is the barrier: the
        // publisher is the one order, whether a fact was published detached or
        // awaited, so a job enqueued here runs after every publication queued
        // before it — while answering for none of them, which a settle could
        // not do without failing this child over some other fact its parent
        // lost.
        yield* session.commit([]);
        // The database refuses a parent that is closed or has no `run.start`;
        // this read only words the refusal before the transaction opens.
        if (!(yield* getRunRecords(session, options.parentRunId).exists()))
          return yield* Effect.fail(
            new Error(`Parent run ${options.parentRunId} is unavailable.`),
          );
      }
      const pinned = pinRunWorkingDirectory(record, session.roots.workspace);
      const target = aggregateId('run', runId);
      const category = isAgentRunRecord(pinned)
        ? pinned.agentCategory
        : (options.category ?? AgentCategory.ToolUse);
      // The launch stamped the resolved source on the record; the registry is
      // not consulted again.
      const isRemote =
        isAgentRunRecord(pinned) && pinned.agentSource === 'remote';
      const events: SessionEventDraft[] = [];
      if (!prior) {
        // The worktree the fold spells is the run's working directory as a
        // bare path chip: the fold never shells out, so `branch`/`dirty`
        // stay absent.
        const worktreeCwd = pinned.workingDirectory?.trim();
        events.push({
          type: 'run.start',
          aggregateId: target,
          identity: options.identity,
          userFollowUpSupport:
            options.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
          category,
          isRemote,
          worktree: worktreeCwd ? { workingDirectory: worktreeCwd } : undefined,
          parent:
            options.parentRunId === undefined
              ? null
              : { id: options.parentRunId },
          approvalPolicy: session.approvalPolicySnapshotFor(runId),
          checkpointId: options.checkpointId,
        });
      }
      events.push(
        {
          type: 'run.record',
          aggregateId: target,
          record: pinned,
        },
        {
          type: 'run.activate',
          aggregateId: target,
          category,
          ...(options.identity.kind === 'agent' &&
          options.identity.tool === undefined
            ? { isRemote }
            : {}),
        },
      );
      // Enforcement is the session's in-memory policy; the row is its
      // projection. A re-registration writes no `run.start`, so the
      // activation re-stamps the snapshot enforcement now holds.
      if (prior)
        events.push({
          type: 'approval.policy',
          aggregateId: target,
          snapshot: session.approvalPolicySnapshotFor(runId),
        });
      if (options.description !== undefined)
        events.push({
          type: 'run.description',
          aggregateId: target,
          description: options.description,
        });
      yield* session.commitRegistration(events);
    }),
  );
});

export interface FinalizeRunInput {
  readonly runId: RunId;
  readonly outcome: RunOutcome;
  /**
   * Keep the outcome this lifecycle already wrote instead of replacing it.
   * For a backstop finalizer that does not own the run's result — the
   * host-exit drain, which can race the run's own driver across the same
   * per-run meta lock — the driver's outcome is the authoritative one. Read
   * and write happen in the same locked cycle, so "already settled" cannot go
   * stale between them.
   */
  readonly keepExistingOutcome?: boolean;
  /** The classified error behind a FAILED outcome, when the run has one. */
  readonly error?: RunEnd['error'];
  /**
   * What the run produced. Absent for a backstop that ends a run whose flow
   * produced nothing (host exit, a stop of a parked run, a failed launch):
   * the row then carries the empty output of the run's category. Also
   * absent, by rule rather than omission, on the child-run path
   * (`finalizeChildRun` in `src/tools/delegation/childRun.ts`): a child's
   * product is its per-turn delivery to its parent, not a flow output.
   */
  readonly output?: RunEndOutput;
  /**
   * Where a persistence failure is reported, wrapped in one worded Error.
   * `finalizeRun` never throws; a caller with its own logging reads the
   * result instead.
   */
  readonly report?: (error: Error) => void;
}

/**
 * A caller's terminal outcome that `finalizeRun` could not commit
 * (`FinalizeRunResult` with `ok: false`), for a caller whose own failure that
 * is; `cause` is the result's `error`.
 */
export class RunOutcomeUnpersisted extends Data.TaggedError(
  'RunOutcomeUnpersisted',
)<{ readonly message: string; readonly cause: unknown }> {}

export type FinalizeRunResult =
  | {
      readonly ok: true;
      /**
       * The outcome that now stands on disk: the requested one, or the one
       * `keepExistingOutcome` retained from the run's own driver. A backstop
       * finalizer settles the rest of the run (its transcript groups) to this
       * value rather than to the one it asked for.
       */
      readonly outcome: RunOutcome;
    }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly outcomePersisted: boolean;
    };

/**
 * The one terminal-persistence tail, and the one writer of the `run.end` row
 * (one run model, section 3.3): persist the run's terminal fact. The run's
 * rows live until explicit deletion (C9); nothing is removed beside the row.
 * Read and write share one locked cycle, so
 * a run whose *current* lifecycle already ended with this outcome writes
 * nothing; a resumed run ends again. Never throws — every persistence
 * failure comes back as an `ok: false` result (and through
 * `report`, when given).
 */
export const finalizeRun = Effect.fn('finalizeRun')(function* (
  session: SessionHandle,
  input: FinalizeRunInput,
): Effect.fn.Return<FinalizeRunResult> {
  const { runId, outcome, keepExistingOutcome } = input;
  // The row's usage is the run's ledger totals, whichever path ends the run:
  // `RunState.usage` folds from the priced `response` rows alone, so a run
  // resumed in this process bills its earlier rounds even when it ends
  // before a round here. Absent for a run with no ledger rows (an agent-CLI
  // child, a launch that failed before its first batch). An unreadable
  // ledger is logged and leaves the row without usage: it must not also
  // cost the run its terminal fact.
  const usage = yield* session.ledger.load(runId).pipe(
    Effect.map((state) => state?.usage),
    Effect.catch((cause) =>
      Effect.logWarning('Failed to read the run usage from its ledger').pipe(
        Effect.annotateLogs({ runId, error: toErrorMessage(cause) }),
        Effect.as(undefined),
      ),
    ),
  );
  const status = yield* Effect.exit(
    session.updateRecordFacts(runId, (rows) =>
      Effect.gen(function* () {
        const target = aggregateId('run', runId);
        const start = rows.find(
          (row): row is Extract<SessionEvent, { type: 'run.start' }> =>
            row.type === 'run.start' && row.aggregateId === target,
        );
        if (!start) {
          return yield* Effect.fail(
            new Error(`Run start not found for ${runId}`),
          );
        }
        // "Already ended" is a fact about the run's current lifecycle, not about
        // the aggregate (`runEndFromEvents` states the rule, and every reader
        // shares it): a resumed run has to end again even when it ends the same
        // way, or the fold, history and every `durableOutcome` reader keep it
        // RUNNING for want of a terminal row.
        const ended = runEndFromEvents(rows, runId)?.outcome;
        const persisted =
          keepExistingOutcome === true && ended !== undefined ? ended : outcome;
        if (ended === persisted) return { events: [], value: persisted };
        return {
          events: [
            ...session.streamClosureFacts(runId),
            {
              type: 'run.end' as const,
              aggregateId: target,
              outcome: persisted,
              ...(input.error !== undefined ? { error: input.error } : {}),
              ...(usage !== undefined ? { usage } : {}),
              output: input.output ?? emptyRunEndOutput(start.category),
            },
          ],
          value: persisted,
        };
      }),
    ),
  );
  if (Exit.isFailure(status)) {
    const error = Cause.squash(status.cause);
    input.report?.(
      new Error(
        `Failed to persist ${outcome} terminal state for run ${runId}: ${toErrorMessage(error)}`,
        { cause: error },
      ),
    );
    return { ok: false, error, outcomePersisted: false };
  }
  return { ok: true, outcome: status.value };
});
