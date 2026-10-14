import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import { isRecipeConfig, type RunId } from '@shared/schemas';
import { DatabaseRowEarlier } from '@shared/session/database';
import { continuesFromRows } from '@shared/session/runActions';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { runEndFromEvents } from './runRecords';

const CHANNEL = 'Resumability';

/**
 * Where a run continues from, read from its durable facts: its rows (its
 * loop opened it), nowhere, or unknown because the facts could not be read.
 * A run its loop drives is born with its opening, so none is registered and
 * never opened.
 */
export type ResumabilityDecision =
  | { readonly kind: 'checkpoint' }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly cause: string }
  | { readonly kind: 'earlierBuild'; readonly refusal: DatabaseRowEarlier };

/** The earlier-build refusal a failed read carries, if any. */
const earlierRefusal = (error: unknown): DatabaseRowEarlier | undefined =>
  [error, error instanceof Error ? error.cause : undefined].find(
    (e): e is DatabaseRowEarlier => e instanceof DatabaseRowEarlier,
  );

/**
 * The one answer to "can this run resume?", before ownership (`runRefusal`
 * adds the claim). An opened run continues whatever its outcome: rows live
 * until deletion, so a failed or cancelled run continues from where they
 * left it. A task that ended does not: its recipe's result is
 * settled, so it runs again instead.
 */
export const deriveResumability = Effect.fn('deriveResumability')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<ResumabilityDecision> {
  const read = yield* session.log.records(runId).pipe(Effect.result);
  // An earlier build's row: this build cannot open the run, and says so.
  const refusal =
    read._tag === 'Failure' ? earlierRefusal(read.failure) : undefined;
  if (refusal !== undefined) return { kind: 'earlierBuild', refusal };
  if (read._tag === 'Failure') {
    const cause = `run state could not be read (${toErrorMessage(read.failure)})`;
    yield* Effect.logWarning(`Run ${runId}: ${cause}`).pipe(
      withLogChannel(CHANNEL),
    );
    return { kind: 'unreadable', cause };
  }
  const records = read.success;
  const start = records.findLast((row) => row.type === 'run.start');
  const config = records.findLast((row) => row.type === 'run.config');
  const standing = {
    ended: runEndFromEvents(records, runId) !== null,
    recipe: config?.type === 'run.config' && isRecipeConfig(config.config),
  };
  return start?.type === 'run.start' &&
    continuesFromRows({ ...standing, identity: start.identity })
    ? { kind: 'checkpoint' }
    : { kind: 'none' };
});
