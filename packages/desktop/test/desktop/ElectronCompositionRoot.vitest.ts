import { homedir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { it } from '@effect/vitest';

import { describe, expect } from 'vitest';
import { withEnv } from '@test/support/testEnv';

describe('desktop launch environment', () => {
  it.effect(
    'shares the CLI ~/.texra data root by default, isolating only under the e2e override (#7987)',
    () =>
      Effect.gen(function* () {
        const { resolveDesktopDataRoot } = yield* Effect.promise(
          () => import('@desktop/main/platform/paths'),
        );
        const userDataPath = '/tmp/some-electron-user-data';

        expect(
          yield* resolveDesktopDataRoot(userDataPath).pipe(withEnv({})),
        ).toBe(join(homedir(), '.texra'));
        expect(
          yield* resolveDesktopDataRoot(userDataPath).pipe(
            withEnv({ TEXRA_DESKTOP_E2E_USER_DATA_PATH: userDataPath }),
          ),
        ).toBe(userDataPath);
      }),
  );
});
