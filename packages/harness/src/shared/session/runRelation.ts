/**
 * A run's line of launchers as its committed rows record it, for a job
 * that writes: the session view states the same lines on each run
 * (`parentId`, `ancestors`, `childIds`), and every reader that only shows
 * them reads the view.
 */
import { Effect } from 'effect';

import type { RunId } from '@shared/schemas';

/**
 * The rows of each run from the `starts` up to their roots, by run: what a
 * job reads parentage or grants from. `read` answers a run's rows, or null
 * for one that is not there; a parent that is not there ends its line.
 */
export const ancestryRows = Effect.fnUntraced(function* <
  Rows extends { readonly parent: { readonly id: RunId } | null },
  E,
>(
  read: (runId: RunId) => Effect.Effect<Rows | null, E>,
  ...starts: readonly (RunId | null)[]
): Effect.fn.Return<ReadonlyMap<RunId, Rows>, E> {
  const rows = new Map<RunId, Rows>();
  for (const start of starts) {
    for (let id = start; id !== null && !rows.has(id);) {
      const own = yield* read(id);
      if (own === null) break;
      rows.set(id, own);
      id = own.parent?.id ?? null;
    }
  }
  return rows;
});
