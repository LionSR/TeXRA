import { randomUUID } from 'node:crypto';

import { Effect, Result } from 'effect';

import { AppState } from '@texra-ai/harness';
import { TexraStateKey } from '@texra/shared/settingsView/texraSettings';

const INSTALL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The random anonymous install ID: a UUIDv4 made once in global app state,
 * never derived from the machine, the user or a login. A stored value that
 * is not a UUIDv4 is replaced. Users reset it by deleting the state key.
 */
export const readOrCreateInstallId = Effect.fn('UsageLogService.installId')(
  function* () {
    const state = yield* AppState;
    const isId = (value: unknown): value is string =>
      typeof value === 'string' && INSTALL_ID_PATTERN.test(value);
    const stored = yield* state.get(TexraStateKey.TELEMETRY_INSTALL_ID);
    if (isId(stored)) return stored;
    return yield* state.modify(TexraStateKey.TELEMETRY_INSTALL_ID, (current) =>
      Result.succeed(isId(current) ? current : randomUUID()),
    );
  },
);
