/**
 * The background leg of a model attempt: submit, commit the accepted
 * operation, observe it, and cancel it when the user stops the run.
 * `ModelInvoker` owns the attempt around it; this is the part that talks to
 * `Model.background`.
 */
import { Cause, Clock, Effect, Stream } from 'effect';

import {
  ModelError,
  type BackgroundEvent,
  type Model,
  type RemoteOperation,
  type ResolvedTurn,
  type TurnResult,
} from '@texra-ai/llm/turn';
import type { InvocationRef } from '@shared/schemas';

import { rowAggregate } from '../loop/rows';
import type { RunCell } from '../loop/runProgram';
import type { InvokeError } from '../ModelInvoker';
import type { AgentRunShape } from './AgentRun';
import type { BoundModel } from './modelBinding';

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
 * stop: the reply commits as the `cancelled` row that retires the operation,
 * so a resume starts anew. Any other interrupt (a shutdown, an unanswered
 * recovery question) has no `user` stop reason and leaves the operation for a
 * resume to observe. A cancel that fails or outlasts its budget is logged
 * loudly and leaves no row, so the still-live operation stays observable; the
 * stop proceeds either way.
 */
export const observeBackground = <E>(
  run: AgentRunShape,
  cell: RunCell,
  background: Background,
  resolved: BackgroundTurn,
  invocation: InvocationRef,
  accepted: {
    readonly operation: RemoteOperation;
    readonly deadlineAtMs: number;
  },
  onEvent: (event: BackgroundEvent) => Effect.Effect<void, E>,
) => {
  const { operation, deadlineAtMs } = accepted;
  const id = operation.providerResponseId;
  const cancel = background.cancel(operation).pipe(
    Effect.timeout(BACKGROUND_CANCEL_TIMEOUT_MS),
    Effect.tap((evidence) =>
      cell.append([
        {
          type: 'model.message',
          aggregateId: rowAggregate(run.runId),
          payload: { kind: 'cancelled', invocation, evidence },
        },
      ]),
    ),
    Effect.flatMap((evidence) =>
      Effect.sync(() => {
        if (evidence.kind !== 'confirmed-cancelled')
          run.logger.warn(
            `The stopped background response ${id} was not confirmed cancelled (${evidence.kind}: ${evidence.status}).`,
          );
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.sync(() =>
        run.logger.warn(
          `Could not cancel the stopped background response ${id}; it may keep running and billing until it finishes.`,
          { data: Cause.squash(cause) },
        ),
      ),
    ),
  );
  return Stream.runForEach(
    background.observe(resolved, operation, { deadlineAtMs }),
    onEvent,
  ).pipe(
    Effect.onInterrupt(() =>
      run.session.runs.stopReason(run.runId) === 'user' ? cancel : Effect.void,
    ),
  );
};

/**
 * Background work: submit, and if the provider accepted it rather than
 * completing at once, commit the `accepted` row with its deadline before
 * `observe` is called (the commit barrier, row 4). A progress callback is no
 * substitute: nothing observes an operation the ledger does not hold.
 */
export const submitAndObserve = Effect.fn('ModelInvoker.background')(function* (
  run: AgentRunShape,
  cell: RunCell,
  resolved: BackgroundTurn,
  invocation: InvocationRef,
  bound: BoundModel,
  onEvent: (event: BackgroundEvent) => Effect.Effect<void, InvokeError>,
  completed: { value: TurnResult | null },
): Effect.fn.Return<void, ModelError | InvokeError> {
  const background = bound.model.background;
  if (background === undefined) {
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'The bound model resolved a background turn it cannot submit.',
    });
  }
  const submission = yield* background.submit(resolved);
  if (submission.kind === 'completed') {
    completed.value = submission.result;
    return;
  }
  const deadlineAtMs =
    (yield* Clock.currentTimeMillis) + BACKGROUND_MAX_DURATION_MS;
  const aggregateId = rowAggregate(run.runId);
  const { operation } = submission;
  yield* cell.append([
    {
      type: 'model.message',
      aggregateId,
      payload: {
        kind: 'identified',
        invocation,
        providerResponseId: operation.providerResponseId,
        returnedModel: submission.returnedModel,
      },
    },
    {
      type: 'model.message',
      aggregateId,
      payload: { kind: 'accepted', invocation, operation, deadlineAtMs },
    },
  ]);
  yield* observeBackground(
    run,
    cell,
    background,
    resolved,
    invocation,
    { operation, deadlineAtMs },
    onEvent,
  );
});
