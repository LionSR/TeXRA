import { Stream } from 'effect';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import {
  DOCUMENTS_OUTPUT_ARM,
  documentRoundsOf,
} from '@shared/plugins/documents';
import { aggregateTarget, type AddOutputFilesPayload } from '@shared/schemas';

/** The output files each documents row owns, from rows committed after this
 *  call on: a stream its reader runs for as long as it listens. */
export function outputFilesProduced(
  session: Pick<SessionHandle, 'events' | 'now'>,
) {
  return session.events.all(session.now()).pipe(
    Stream.flatMap((event): Stream.Stream<AddOutputFilesPayload> => {
      if (
        event.type !== 'plugin.fact' ||
        event.plugin !== DOCUMENTS_OUTPUT_ARM.plugin ||
        event.kind !== DOCUMENTS_OUTPUT_ARM.kind
      )
        return Stream.empty;
      const target = aggregateTarget(event.aggregateId);
      if (target.kind !== 'run') return Stream.empty;
      return Stream.make({
        runId: target.id,
        filesByRound: Object.fromEntries(
          documentRoundsOf(event.value).map((round) => [
            round.round,
            round.outputs,
          ]),
        ),
      });
    }),
  );
}
