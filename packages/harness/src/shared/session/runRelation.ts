/**
 * A run's line of launchers as the store records it, for code that must
 * not trail the log (a job that writes, a stop's cascade): its ids
 * ({@link ancestorIds}) or its rows ({@link ancestryRows}). The session
 * view states the same lines on each run (`parentId`, `ancestors`,
 * `childIds`), and every reader that only shows them reads the view.
 */
import { Effect } from 'effect';

import type { RunId } from '@shared/schemas';

/**
 * The runs above `runId`, nearest first, as `parentOf` answers each edge.
 * A run an edge names is on the line whatever else is known of it (one
 * since removed still is). Parentage is a tree; a run already on the line
 * only ends a corrupt cycle.
 */
export const ancestorIds = Effect.fnUntraced(function* <E>(
  parentOf: (runId: RunId) => Effect.Effect<RunId | null, E>,
  runId: RunId,
): Effect.fn.Return<RunId[], E> {
  const line: RunId[] = [];
  for (
    let id = yield* parentOf(runId);
    id !== null && !line.includes(id);
    id = yield* parentOf(id)
  )
    line.push(id);
  return line;
});

/**
 * The rows of each run from the `starts` up to their roots, by run: what a
 * job reads parentage or grants from. `read` answers a run's rows, or null
 * for one that is not there; a parent that is not there ends its line.
 */
export const ancestryRows = Effect.fnUntraced(function* <
  Rows extends {
    readonly start: { readonly parent: { readonly id: RunId } | null } | null;
  },
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
      id = own.start?.parent?.id ?? null;
    }
  }
  return rows;
});
