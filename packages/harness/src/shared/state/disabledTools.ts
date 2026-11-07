/**
 * The tool switch record: the plugin ids the user holds off, in the
 * process's global state (`AppState`), and its one decoder.
 */
import { Result, Schema } from 'effect';

import type { StateKey } from '@shared/state/stateSettings';

/** The tool switch record's key; its value is the list of plugin ids held off. */
export const DISABLED_TOOLS_KEY = {
  key: 'tools.disabled',
  slot: 'globalState',
  schema: Schema.Array(Schema.String),
} as const satisfies StateKey<readonly string[]>;

/**
 * The tool switch record ({@link DISABLED_TOOLS_KEY}) as stored,
 * checked: the plugin ids the user holds off, or `undefined` while nothing
 * (neither the first-install seed nor the user) has written it. A present
 * value that is not a list of ids is corruption and fails with the reason,
 * rather than reading as "nothing off", which would switch every opt-in
 * plugin on. The one decoder of the record; each reader turns the failure
 * into its own error.
 */
export function decodeDisabledTools(stored: unknown): Result.Result<
  ReadonlySet<string> | undefined,
  {
    readonly key: string;
    readonly message: string;
    readonly cause: Schema.SchemaError;
  }
> {
  if (stored === undefined) return Result.succeed(undefined);
  const { key } = DISABLED_TOOLS_KEY;
  return Result.mapBoth(
    Schema.decodeUnknownResult(DISABLED_TOOLS_KEY.schema)(stored),
    {
      onSuccess: (ids): ReadonlySet<string> => new Set(ids),
      onFailure: (cause) => ({
        key,
        message: `The tool switch record (${key}) is unreadable: ${cause.message}`,
        cause,
      }),
    },
  );
}
