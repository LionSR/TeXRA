import { randomUUID } from 'node:crypto';

import { Effect, Result, Schema } from 'effect';

import { AppState } from '@texra-ai/harness/host';
import type { StateKey } from '@texra-ai/harness/schemas';

/** The random anonymous telemetry install ID, a UUIDv4; deleting the key
 *  resets it. */
const INSTALL_ID_KEY = {
  key: 'telemetry.installId',
  slot: 'globalState',
  schema: Schema.String.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
} as const satisfies StateKey<string>;

/**
 * The random anonymous install ID: a UUIDv4 made once in global app state,
 * never derived from the machine, the user or a login. A stored value that
 * is not a UUIDv4 is replaced. Users reset it by deleting the state key.
 */
export const readOrCreateInstallId = Effect.fn('UsageLogService.installId')(
  function* () {
    const state = yield* AppState;
    const isId = Schema.is(INSTALL_ID_KEY.schema);
    const stored = yield* state.get(INSTALL_ID_KEY.key);
    if (isId(stored)) return stored;
    return yield* state.modify(INSTALL_ID_KEY.key, (current) =>
      Result.succeed(isId(current) ? current : randomUUID()),
    );
  },
);
