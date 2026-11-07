/**
 * The background leg of a model attempt: submit, commit the accepted
 * operation, observe it, and cancel it when the user stops the run.
 * `ModelInvoker` owns the attempt around it; this is the part that talks to
 * `Model.background`.
 */
import { Cause, Clock, Effect, Exit, Stream } from 'effect';

import {
  ModelError,
  type Model,
  type RemoteOperation,
  type ResolvedTurn,
  type TurnEvent,
} from '@texra-ai/llm';
import type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
import { qualifyAggregateId, type InvocationRef } from '@shared/schemas';

import { type RunCell, SessionLog } from '@shared/session/runHistory';
import type { InvokeError } from '../ModelInvoker';
import type { AgentRunShape } from './AgentRun';

type BackgroundTurn = Extract<ResolvedTurn, { mode: 'background' }>;
type Background = NonNullable<Model['background']>;

/**
 * How long accepted background work is observed after its submission, as
 * the retired poller allowed. The deadline is absolute and recorded with the
 * `accepted` row: a resume observes under the original one, never a fresh one.
 */
const BACKGROUND_MAX_DURATION_MS = 3 * 60 * 60 * 1000;

/** How long a user stop waits on the provider to cancel background work. */
const BACKGROUND_CANCEL_TIMEOUT_MS = 15_000;

/**
 * Observe an accepted operation, cancelling it if the run unwinds from a user
 * stop: a confirmed cancel commits the `cancelled` row that retires the
 * operation, so a resume starts anew. Any other interrupt (a shutdown, an
 * unanswered recovery question) has no `user` stop reason and leaves the
 * operation for a resume to observe. A cancel the provider does not confirm,
 * that fails, or that outlasts its budget is logged loudly and leaves no
 * row, so the operation stays observable; the stop proceeds either way.
 */
export const observeBackground = (
  run: AgentRunShape,
  cell: RunCell,
  background: Background,
  resolved: BackgroundTurn,
  invocation: InvocationRef,
  accepted: {
    readonly operation: RemoteOperation;
    readonly deadlineAtMs: number;
  },
): Stream.Stream<TurnEvent, ModelError, SessionLog> => {
  const { operation, deadlineAtMs } = accepted;
  const id = operation.providerResponseId;
  // Each step's failure is its own fact: a cancel that failed may still be
  // billing, while a confirmed cancel whose row did not commit only leaves
  // the operation for a resume to observe again.
  const retire = cell
    .append([
      {
        type: 'model.message',
        aggregateId: qualifyAggregateId('run', run.runId),
        payload: { kind: 'cancelled', invocation },
      },
    ])
    .pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() =>
          run.logger.warn(
            `The background response ${id} was cancelled, but its cancelled row was not written; a resume observes it again.`,
            { data: Cause.squash(cause) },
          ),
        ),
      ),
    );
  const cancel = background.cancel(operation).pipe(
    Effect.timeout(BACKGROUND_CANCEL_TIMEOUT_MS),
    Effect.matchCauseEffect({
      onSuccess: () => retire,
      onFailure: (cause) =>
        Effect.sync(() =>
          run.logger.warn(
            `Could not cancel the stopped background response ${id}; it may keep running and billing until it finishes.`,
            { data: Cause.squash(cause) },
          ),
        ),
    }),
  );
  return background.observe(resolved, operation, { deadlineAtMs }).pipe(
    Stream.onExit((exit) =>
      Exit.hasInterrupts(exit)
        ? Effect.flatMap(
            Effect.flatMap(SessionLog, (log) => log.facts(run.runId)),
            (facts) =>
              facts?.stop == null || facts.stop.reason === 'shutdown'
                ? Effect.void
                : cancel,
          ).pipe(Effect.orDie)
        : Effect.void,
    ),
  );
};

/**
 * Background work as the attempt's events: submit, and if the provider
 * accepted it rather than completing at once, commit the `accepted` row with
 * its deadline before `observe` is called (the commit barrier, row 4). A
 * progress callback is no substitute: nothing observes an operation the run
 * history does not hold. A submission that completed at once is its one
 * `completed` event.
 */
export const submitAndObserve = (
  run: AgentRunShape,
  cell: RunCell,
  resolved: BackgroundTurn,
  invocation: InvocationRef,
  bound: BoundModel,
): Stream.Stream<TurnEvent, ModelError | InvokeError, SessionLog> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const background = bound.model.background;
      if (background === undefined) {
        return yield* new ModelError({
          kind: 'invalid-request',
          message:
            'The bound model resolved a background turn it cannot submit.',
        });
      }
      const submission = yield* background.submit(resolved);
      if (submission.kind === 'completed')
        return Stream.succeed<TurnEvent>({
          kind: 'completed',
          result: submission.result,
        });
      const deadlineAtMs =
        (yield* Clock.currentTimeMillis) + BACKGROUND_MAX_DURATION_MS;
      const aggregateId = qualifyAggregateId('run', run.runId);
      const { operation } = submission;
      yield* cell.append([
        {
          type: 'model.message',
          aggregateId,
          payload: {
            kind: 'identified',
            invocation,
            providerResponseId: operation.providerResponseId,
          },
        },
        {
          type: 'model.message',
          aggregateId,
          payload: { kind: 'accepted', invocation, operation, deadlineAtMs },
        },
      ]);
      return observeBackground(run, cell, background, resolved, invocation, {
        operation,
        deadlineAtMs,
      });
    }).pipe(Effect.withSpan('ModelInvoker.background')),
  );
