import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import {
  isDocumentTaskConfig,
  isLoopDriven,
  type RunId,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { runEndFromEvents } from './runRecords';

const CHANNEL = 'Resumability';

/**
 * Where a run continues from, read from its durable facts: its rows (its
 * loop opened it), its configuration (registered, not ended, never opened),
 * nowhere, or unknown because the facts could not be read.
 */
export type ResumabilityDecision =
  | { readonly kind: 'checkpoint' }
  | { readonly kind: 'unopened' }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly cause: string };

/**
 * The one answer to "can this run resume?", before ownership (`classifyRun`
 * adds the claim). An opened run continues whatever its outcome: rows live
 * until deletion, so a failed or cancelled run continues from where they
 * left it. A document task that ended does not: its recipe's result is
 * settled, so it runs again instead. A loop-driven run that stopped before
 * its opening and never ended reopens from its configuration.
 */
export const deriveResumability = Effect.fn('deriveResumability')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<ResumabilityDecision> {
  const read = yield* session.readRunRecords(runId).pipe(Effect.result);
  if (read._tag === 'Failure') {
    const cause = `run state could not be read (${toErrorMessage(read.failure)})`;
    yield* Effect.logWarning(`Run ${runId}: ${cause}`).pipe(
      withLogChannel(CHANNEL),
    );
    return { kind: 'unreadable', cause };
  }
  const records = read.success;
  const ended = runEndFromEvents(records, runId) !== null;
  const config = records.findLast((row) => row.type === 'run.config');
  if (
    ended &&
    config?.type === 'run.config' &&
    isDocumentTaskConfig(config.config)
  )
    return { kind: 'none' };
  if (records.some((row) => row.type === 'run.position'))
    return { kind: 'checkpoint' };
  const start = records.find((row) => row.type === 'run.start');
  return start?.type === 'run.start' && isLoopDriven(start.identity) && !ended
    ? { kind: 'unopened' }
    : { kind: 'none' };
});
