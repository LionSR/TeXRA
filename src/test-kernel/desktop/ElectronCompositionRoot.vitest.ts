import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { Effect } from 'effect';
import { it as effectIt } from '@effect/vitest';

import { describe, expect, it } from 'vitest';
import { sourceFilesUnder } from '@test/support/repoScan';
import { withEnv } from '@test/support/testEnv';
import { normalizeFilePath } from '@utils/core';
import { DESKTOP_SRC_DIR, REPO_ROOT } from './desktopTestPaths.ts';

describe('desktop composition root and launch environment', () => {
  it('keeps the process runtime install in the Electron composition root', async () => {
    const files = sourceFilesUnder(DESKTOP_SRC_DIR);
    const installFiles: string[] = [];

    for (const filePath of files) {
      const source = await readFile(filePath, 'utf8');
      if (source.includes('processLayer(')) {
        installFiles.push(normalizeFilePath(relative(REPO_ROOT, filePath)));
      }
    }

    expect(installFiles).toEqual([
      'packages/desktop/src/main/platform/index.ts',
    ]);
  });

  effectIt.effect(
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
