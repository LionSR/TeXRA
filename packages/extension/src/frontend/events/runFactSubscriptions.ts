import { Stream } from 'effect';

import {
  DOCUMENTS_OUTPUT_KEY,
  documentRoundsOf,
} from '@shared/plugins/documents';
import type { AddOutputFilesPayload, RunId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';

/**
 * The output files a run's documents fact names, each time it changes from
 * the view this stream starts at: what the view holds then is not new. It
 * reads the view, not the event tail, so a window whose runs run in the
 * background service sees them as one whose runs run here does.
 */
export function outputFilesProduced(source: {
  readonly viewChanges: Stream.Stream<SessionView>;
}): Stream.Stream<AddOutputFilesPayload> {
  return Stream.suspend(() => {
    // By value: a view rebuilt from the same rows (a resubscribed window)
    // names no new output.
    let seen: ReadonlyMap<RunId, string> | undefined;
    return source.viewChanges.pipe(
      Stream.flatMap((view) => {
        const now = new Map<RunId, string>();
        const changed: AddOutputFilesPayload[] = [];
        for (const run of view.runs.values()) {
          const fact = run.facts[DOCUMENTS_OUTPUT_KEY];
          if (fact === undefined) continue;
          const value = JSON.stringify(fact);
          now.set(run.id, value);
          if (seen !== undefined && seen.get(run.id) !== value)
            changed.push({
              runId: run.id,
              filesByRound: Object.fromEntries(
                documentRoundsOf(fact).map((round) => [
                  round.round,
                  round.outputs,
                ]),
              ),
            });
        }
        seen = now;
        return Stream.fromIterable(changed);
      }),
    );
  });
}
