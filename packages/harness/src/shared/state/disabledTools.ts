/**
 * The tool switch record: the plugin ids the user holds off, in the
 * process's global state (`AppState`), with its read, its first-install seed
 * and its toggle.
 */
import { Effect, Result, Schema } from 'effect';

import { StateReadFailed, type StateStore } from '@shared/config/settings';
import type { StateKey } from '@shared/state/stateSettings';

/** The tool switch record's key; its value is the list of plugin ids held off. */
export const DISABLED_TOOLS_KEY = {
  key: 'tools.disabled',
  slot: 'globalState',
  schema: Schema.Array(Schema.String),
} as const satisfies StateKey<readonly string[]>;

const { key } = DISABLED_TOOLS_KEY;

/**
 * The record as stored, checked: the plugin ids the user holds off, or
 * `undefined` while nothing (neither the first-install seed nor the user) has
 * written it. A present value that is not a list of ids is corruption and
 * fails with the reason, rather than reading as "nothing off", which would
 * switch every opt-in plugin on.
 */
function decodeDisabledTools(
  stored: unknown,
): Result.Result<ReadonlySet<string> | undefined, StateReadFailed> {
  if (stored === undefined) return Result.succeed(undefined);
  return Result.mapBoth(
    Schema.decodeUnknownResult(DISABLED_TOOLS_KEY.schema)(stored),
    {
      onSuccess: (ids): ReadonlySet<string> => new Set(ids),
      onFailure: (cause) =>
        new StateReadFailed({
          key,
          message: `The tool switch record (${key}) is unreadable: ${cause.message}`,
          cause,
        }),
    },
  );
}

/** The plugin ids the user switched off in `store`'s record; none while it
 *  is absent. */
export function readDisabledTools(store: StateStore) {
  return store.get(key).pipe(
    Effect.flatMap((stored) => Effect.fromResult(decodeDisabledTools(stored))),
    Effect.map((ids): ReadonlySet<string> => ids ?? new Set()),
  );
}

/**
 * Write `ids` as the record only while it is absent, answering whether it
 * wrote. The record is its own fresh-install signal: a present one (an empty
 * list included) holds the user's choices, which a re-seed would undo. The
 * read and the write are one `modify`, so a switch another process records
 * between them is kept.
 */
export function seedDisabledTools(store: StateStore, ids: readonly string[]) {
  return store.modify([key], (stored) =>
    Result.map(decodeDisabledTools(stored[key]), (recorded) =>
      recorded === undefined
        ? ([true, { [key]: ids }] as const)
        : ([false] as const),
    ),
  );
}

/** Switch plugin `id` on or off in `store`'s record. */
export function setToolEnabled(
  store: StateStore,
  id: string,
  enabled: boolean,
) {
  return store.modify([key], (stored) =>
    Result.map(decodeDisabledTools(stored[key]), (current) => {
      const disabled = new Set(current);
      if (enabled) disabled.delete(id);
      else disabled.add(id);
      return [undefined, { [key]: [...disabled] }] as const;
    }),
  );
}
