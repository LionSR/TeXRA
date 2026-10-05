import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import {
  isDocumentTaskConfig,
  isLoopDriven,
  type RunSnapshotPayload,
  type RunId,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { runEndFromEvents } from './runRecords';

const CHANNEL = 'Resumability';

/**
 * Where a run continues from, read from its durable facts: its latest
 * `run.snapshot`, its configuration (registered, not ended, never opened),
 * nowhere, or unknown because the facts could not be read.
 */
export type ResumabilityDecision =
  | { readonly kind: 'checkpoint'; readonly snapshot: RunSnapshotPayload }
  | { readonly kind: 'unopened' }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly cause: string };

/**
 * The one answer to "can this run resume?", before ownership (`classifyRun`
 * adds the claim). A snapshot continues the run whatever its outcome: rows
 * live until deletion, so a failed or cancelled run continues from its last
 * one. A document task that ended does not: its recipe's result is settled,
 * so it runs again instead. A loop-driven run that stopped before its first
 * snapshot and never ended reopens from its configuration.
 */
export const deriveResumability = Effect.fn('deriveResumability')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<ResumabilityDecision> {
  const read = yield* Effect.all([
    session.readRunRecords(runId),
    session.runHistory.latestSnapshot(runId),
  ]).pipe(Effect.result);
  if (read._tag === 'Failure') {
    const cause = `run state could not be read (${toErrorMessage(read.failure)})`;
    yield* Effect.logWarning(`Run ${runId}: ${cause}`).pipe(
      withLogChannel(CHANNEL),
    );
    return { kind: 'unreadable', cause };
  }
  const [records, snapshot] = read.success;
  const ended = runEndFromEvents(records, runId) !== null;
  const config = records.findLast((row) => row.type === 'run.config');
  if (
    ended &&
    config?.type === 'run.config' &&
    isDocumentTaskConfig(config.config)
  )
    return { kind: 'none' };
  if (snapshot !== null)
    return { kind: 'checkpoint', snapshot: snapshot.payload };
  const start = records.find((row) => row.type === 'run.start');
  return start?.type === 'run.start' && isLoopDriven(start.identity) && !ended
    ? { kind: 'unopened' }
    : { kind: 'none' };
});
