import { Stream } from 'effect';

import type { OutputFileInfo } from '@texra/shared/plugins/documentOutputs';
import { documentRoundsOf } from '@texra/shared/plugins/documents';
import type { RunId, RunView, SessionView } from '@texra-ai/harness/schemas';

/**
 * The output files a run's documents fact names, every revision's, each time
 * it changes from
 * the view this stream starts at: what the view holds then is not new. It
 * reads the view, not the event tail, so a window whose runs run in the
 * background service sees them as one whose runs run here does.
 */
export function outputFilesProduced(source: {
  readonly view: { readonly changes: Stream.Stream<SessionView> };
}): Stream.Stream<readonly OutputFileInfo[]> {
  // By value: a view rebuilt from the same rows (a resubscribed window)
  // names no new output. A run's `facts` object is replaced only when a
  // fact lands, so the same one needs no decode.
  type Seen = { readonly facts: RunView['facts']; readonly value: string };
  return source.view.changes.pipe(
    Stream.mapAccum(
      (): ReadonlyMap<RunId, Seen> | undefined => undefined,
      (seen, view) => {
        const now = new Map<RunId, Seen>();
        const changed: (readonly OutputFileInfo[])[] = [];
        for (const run of view.runs.values()) {
          const prior = seen?.get(run.id);
          if (prior?.facts === run.facts) {
            now.set(run.id, prior);
            continue;
          }
          const rounds = documentRoundsOf(run);
          if (rounds.length === 0) continue;
          const value = JSON.stringify(rounds);
          now.set(run.id, { facts: run.facts, value });
          if (seen !== undefined && prior?.value !== value)
            changed.push(rounds.flatMap((round) => round.outputs));
        }
        return [now, changed] as const;
      },
    ),
  );
}
