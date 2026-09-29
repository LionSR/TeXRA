/** The desktop profile's ordered project selection, independent of project sessions. */
import { Context, Effect, Result } from 'effect';

import { GlobalDatabase } from '@shared/session/database';

/** How many closed projects File > Open Recent offers. */
const RECENT_PROJECT_LIMIT = 10;

/** The one profile value's key. */
const PROFILE = 'profile';

interface ProjectLists {
  readonly remembered: readonly string[];
  readonly recent: readonly string[];
}

const EMPTY: ProjectLists = { remembered: [], recent: [] };

/**
 * The remembered projects, on the process's handle on the global root.
 *
 * That root is the shared `~/.texra` this process already keeps its sessions,
 * inquiry threads and update check in, not the Electron profile directory
 * this list used to be written to: the same ruling that moved the
 * update-check row onto the one process handle moves this row with it, since
 * one handle per process is the point and a second root would mean a second
 * connection and a second change poll for one list.
 *
 * Two lists in one current value: `remembered` is what reopens at launch,
 * the one shown last; `recent` is the closed projects File > Open Recent
 * offers, the most recently closed first.
 */
export const openDesktopProjectRecords = Effect.gen(function* () {
  const { values } = yield* GlobalDatabase;
  const lists = Effect.map(
    values.get('desktop-projects', PROFILE),
    (stored) => stored ?? EMPTY,
  );
  const read = Effect.map(lists, ({ remembered }) => remembered);
  const readRecent = Effect.map(lists, ({ recent }) => recent);
  // Both lists are one value, so a close that changes both is one write.
  const update = (change: (lists: ProjectLists) => ProjectLists) =>
    values.modify('desktop-projects', PROFILE, (stored) => {
      const next = change(stored ?? EMPTY);
      return Result.succeed([
        undefined,
        { remembered: [...next.remembered], recent: [...next.recent] },
      ] as const);
    });
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
