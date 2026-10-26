import { stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { CliUsageError } from '@cli/runtime/cliContext';
import {
  assertOutputDirAvailable,
  assertOutputFileAvailable,
} from '@cli/runtime/workflowOutput';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempDirs = useTempDirs();

// `it.live`, not `it.effect`, for the suites below: they probe the real
// filesystem, so a TestContext clock starting at 0 would be a trap rather
// than a help.
describe('dangling output symlinks', () => {
  it.live(
    'keeps a dangling --output symlink writable and rejects a dangling --output-dir before run',
    (context) =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          makeTempDir('texra-cli-dangling-output-', tempDirs),
        );
        const fileReferent = join(root, 'absent.tex');
        const fileLink = join(root, 'file-link.tex');
        const directoryReferent = join(root, 'absent-directory');
        const directoryLink = join(root, 'directory-link');
        const linkError = yield* Effect.match(
          Effect.tryPromise({
            try: async () => {
              await symlink(fileReferent, fileLink, 'file');
              await symlink(
                directoryReferent,
                directoryLink,
                process.platform === 'win32' ? 'junction' : 'dir',
              );
            },
            catch: (error: unknown) => error,
          }),
          {
            onSuccess: () => undefined,
            onFailure: (error: unknown) => error,
          },
        );
        if (linkError !== undefined) {
          const code = (linkError as NodeJS.ErrnoException | undefined)?.code;
          if (
            typeof code === 'string' &&
            ['EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(code)
          ) {
            context.skip();
            return;
          }
          throw linkError;
        }

        expect(
          yield* assertOutputFileAvailable(fileLink, root),
        ).toBeUndefined();

        const dirError = yield* Effect.flip(
          assertOutputDirAvailable(directoryLink, root),
        );
        expect(dirError).toBeInstanceOf(CliUsageError);

        const statError = yield* Effect.flip(
          Effect.tryPromise({
            try: () => stat(directoryReferent),
            catch: (error: unknown) => error,
          }),
        );
        expect(statError).toMatchObject({ code: 'ENOENT' });
      }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
