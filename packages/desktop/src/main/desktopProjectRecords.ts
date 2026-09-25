/** The desktop profile's ordered project selection, independent of project sessions. */
import { Context, Effect } from 'effect';

import { aggregateId, type AggregateId } from '@shared/schemas';
import { GlobalDatabase } from '@shared/session/database';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';

/** How many closed projects File > Open Recent offers. */
const RECENT_PROJECT_LIMIT = 10;

/**
 * The remembered projects, on the process's handle on the global root.
 *
 * That root is the shared `~/.texra` this process already keeps its sessions,
 * inquiry threads and update check in, not the Electron profile directory
 * this list used to be written to: the same ruling that moved the
 * update-check row onto the one process handle moves this row with it, since
 * one handle per process is the point and a second root would mean a second
 * connection and a second change poll for one list. The move is a one-time
 * loss of the remembered list for an existing install — the first launch
 * after it shows no recent projects and the list fills again as projects are
 * opened. Nothing reads the old row: a reader for it would be exactly the
 * legacy-format path this repo does not keep.
 *
 * Two lists on two aggregates of the same kind: `remembered` is what
 * reopens at launch, the one shown last; `recent` is the closed projects
 * File > Open Recent offers, the most recently closed first.
 */
export const openDesktopProjectRecords = Effect.gen(function* () {
  const database = yield* GlobalDatabase;
  const lanes = new Map<string, PerKeyLane>();
  const readList = (id: AggregateId) =>
    Effect.gen(function* () {
      const latest = yield* database.readDesktopProjects(id);
      if (latest === undefined) return [] as readonly string[];
      if (
        latest.type !== 'state.value.set' ||
        latest.state.key !== 'desktop-projects'
      ) {
        return yield* Effect.fail(new Error('Invalid desktop project record'));
      }
      return latest.state.roots;
    });
  const writeList = (
    id: AggregateId,
    current: readonly string[],
    roots: readonly string[],
  ) =>
    roots.length === current.length &&
    roots.every((root, index) => root === current[index])
      ? Effect.void
      : database.appendAll([
          {
            type: 'state.value.set',
            aggregateId: id,
            state: { key: 'desktop-projects', roots: [...roots] },
          },
        ]);
  const rememberedId = aggregateId('desktop-projects', 'remembered');
  const recentId = aggregateId('desktop-projects', 'recent');
  const read = readList(rememberedId);
  const readRecent = readList(recentId);
  // One lane for both lists: a close writes both, and an open reads the one
  // the close is still writing.
  const update = (
    change: (lists: {
      remembered: readonly string[];
      recent: readonly string[];
    }) => { remembered: readonly string[]; recent: readonly string[] },
  ) =>
    Effect.gen(function* () {
      const current = { remembered: yield* read, recent: yield* readRecent };
      const next = change(current);
      yield* writeList(rememberedId, current.remembered, next.remembered);
      yield* writeList(recentId, current.recent, next.recent);
    }).pipe(withPerKeyLane(lanes, 'records'));
  const withoutRecent = (recent: readonly string[], root: string) =>
    recent.filter((entry) => entry !== root);
  return {
    read,
    readRecent,
    remember: (root: string) =>
      update(({ remembered, recent }) => ({
        remembered: remembered.includes(root)
          ? remembered
          : [...remembered, root],
        recent: withoutRecent(recent, root),
      })),
    activate: (root: string) =>
      update(({ remembered, recent }) => ({
        remembered: [...remembered.filter((entry) => entry !== root), root],
        recent,
      })),
    forget: (root: string, activeRoot?: string) =>
      update(({ remembered, recent }) => {
        const remaining = remembered.filter((entry) => entry !== root);
        return {
          remembered:
            activeRoot === undefined
              ? remaining
              : [
                  ...remaining.filter((entry) => entry !== activeRoot),
                  activeRoot,
                ],
          recent: [root, ...withoutRecent(recent, root)].slice(
            0,
            RECENT_PROJECT_LIMIT,
          ),
        };
      }),
    replace: (roots: readonly string[]) =>
      update(({ recent }) => ({ remembered: roots, recent })),
    replaceRecent: (roots: readonly string[]) =>
      update(({ remembered }) => ({ remembered, recent: roots })),
  };
});

type DesktopProjectRecordsShape = Effect.Success<
  typeof openDesktopProjectRecords
>;

/** The remembered and recent project lists, served to the registry and the
 *  launch read by the startup program that opened them. */
export class DesktopProjectRecords extends Context.Service<
  DesktopProjectRecords,
  DesktopProjectRecordsShape
>()('@texra/desktop/DesktopProjectRecords') {}
