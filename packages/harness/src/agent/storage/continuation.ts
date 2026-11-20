import { Effect, Schema } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { programOf, type ResumeRefusal, type RunId } from '@shared/schemas';
import { continuesFromRows } from '@shared/session/runActions';
import { runReadRefusal, SessionLog } from '@shared/session/runHistory';
import type { RunRows } from '@shared/session/runRowsShape';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'Continuation';

/** A run's state that could not be read right now. */
class RunStateUnread extends Schema.TaggedError<RunStateUnread>()(
  'RunStateUnread',
  { message: Schema.String },
) {}

/** Where a run continues from: a point its loop opened, none, rows an
 *  earlier build wrote, rows that are damaged or cannot be continued, a
 *  point whose plugin facts this process cannot interpret, or unknown
 *  because they could not be read. */
type ContinuationDecision =
  | { readonly kind: 'checkpoint' }
  | { readonly kind: 'unreadable'; readonly cause: string }
  | { readonly kind: 'unusableCheckpoint'; readonly cause: string }
  | Extract<
      ResumeRefusal,
      { readonly kind: 'finished' | 'earlierBuild' | 'pluginUnavailable' }
    >;

/**
 * The one answer to "can this run continue here?". An opened run continues whatever its outcome: rows live
 * until deletion, so a failed or cancelled run continues from where they
 * left it. A program's run that ended does not: its result is
 * finished, so it runs again instead. One holding a fact of a plugin this
 * process does not load waits for it: the plugin's state is part of where
 * it continues from.
 */
export const deriveContinuation = Effect.fn('deriveContinuation')(function* (
  runId: RunId,
): Effect.fn.Return<ContinuationDecision, never, SessionLog> {
  const read = yield* (yield* SessionLog).facts(runId).pipe(Effect.result);
  if (read._tag === 'Failure') {
    const refused = runReadRefusal(read.failure);
    const message = toErrorMessage(read.failure);
    // An earlier build's row: this build cannot open the run, and says so.
    if (refused === 'earlierBuild')
      return { kind: 'earlierBuild', cause: message };
    // A damaged or unusable row reads the same way every time: no retry
    // helps, unlike a read that failed.
    const decision: ContinuationDecision =
      refused === undefined
        ? {
            kind: 'unreadable',
            cause: `run state could not be read (${message})`,
          }
        : {
            kind: 'unusableCheckpoint',
            cause: `run state cannot be used (${message})`,
          };
    yield* Effect.logWarning(`Run ${runId}: ${decision.cause}`).pipe(
      withLogChannel(CHANNEL),
    );
    return decision;
  }
  return continuationOf(read.success);
});

/**
 * {@link deriveContinuation} over facts already read: a point its loop
 * opened, a run that is finished, or one waiting for a plugin. A resume
 * and a recovered child, which have read the run's facts for their own
 * decisions, ask this rather than reading them again.
 */
export function continuationOf(
  facts: RunRows | null,
): Extract<
  ContinuationDecision,
  { readonly kind: 'checkpoint' | 'finished' | 'pluginUnavailable' }
> {
  if (
    facts?.start == null ||
    !continuesFromRows({
      ended: facts.end !== null,
      program:
        facts.config === null ? null : (programOf(facts.config)?.name ?? null),
      identity: facts.start.identity,
    })
  )
    return { kind: 'finished' };
  for (const { plugin, unavailable } of Object.values(facts.facts))
    if (unavailable !== undefined)
      return { kind: 'pluginUnavailable', plugin, cause: unavailable };
  return { kind: 'checkpoint' };
}

/**
 * {@link deriveContinuation} as a refusal, or null when the run may
 * continue; facts that could not be read right now fail. The decider for
 * a message to a stored run with no loop here; a resume and a recovered
 * child ask {@link continuationOf} over their own read.
 */
export const checkpointRefusal = Effect.fn('checkpointRefusal')(function* (
  runId: RunId,
): Effect.fn.Return<ResumeRefusal | null, RunStateUnread, SessionLog> {
  const decision = yield* deriveContinuation(runId);
  if (decision.kind === 'checkpoint') return null;
  if (decision.kind === 'unreadable')
    return yield* new RunStateUnread({
      message: `Could not read the state of run ${runId}: ${decision.cause}`,
    });
  if (decision.kind === 'unusableCheckpoint')
    return { kind: 'unusableCheckpoint' };
  return decision;
});
