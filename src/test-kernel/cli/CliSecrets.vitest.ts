import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect, vi } from 'vitest';

import { CliSecrets, cliSecretsPath } from '@cli/runtime/cliSecrets';
import { withTempDir, withTempDirEffect } from '@test/support/tempDirPlatform';
import { withEnv } from '@test/support/testEnv';

async function withSecretsRoot(
  run: (paths: {
    root: string;
    storageRoot: string;
    secretsPath: string;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir('texra-cli-secrets-', async (root) => {
    const storageRoot = path.join(root, 'storage');
    await run({ root, storageRoot, secretsPath: cliSecretsPath(storageRoot) });
  });
}

function withSecretsRootEffect<A, E, R>(
  run: (paths: {
    root: string;
    storageRoot: string;
    secretsPath: string;
  }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return withTempDirEffect('texra-cli-secrets-', (root) => {
    const storageRoot = path.join(root, 'storage');
    return run({ root, storageRoot, secretsPath: cliSecretsPath(storageRoot) });
  });
}

describe('CLI secrets', () => {
  // POSIX file modes don't exist on Windows. skipIf (rather than an early
  // return) so the skip is visible in reports instead of a zero-assertion pass.
  const itPosix = it.effect.skipIf(process.platform === 'win32');

  it.effect(
    'aborts a write instead of wiping the file when the read fails for a reason other than a missing file',
    () =>
      Effect.gen(function* () {
        yield* withSecretsRootEffect(({ secretsPath }) =>
          Effect.gen(function* () {
            const secrets = new CliSecrets(secretsPath);
            yield* secrets.set('EXISTING_KEY', 'existing-value');

            // Corrupt the on-disk file to simulate a non-ENOENT read failure
            // (e.g. corrupt JSON, or an EACCES/EMFILE on the real fs.readFile).
            yield* Effect.promise(() =>
              fs.writeFile(secretsPath, '{ not valid json', 'utf8'),
            );

            const error = yield* Effect.flip(
              secrets.set('NEW_KEY', 'new-value'),
            );
            expect(error).toBeInstanceOf(Error);

            // The mutation must have aborted rather than overwriting the file
            // with a fresh `{}` merged with just the new key.
            const onDisk = yield* Effect.promise(() =>
              fs.readFile(secretsPath, 'utf8'),
            );
            expect(onDisk).toBe('{ not valid json');

            // The queue must not be stuck: a subsequent read/write still works.
            yield* Effect.promise(() =>
              fs.writeFile(
                secretsPath,
                '{"EXISTING_KEY":"existing-value"}\n',
                'utf8',
              ),
            );
            yield* secrets.set('ANOTHER_KEY', 'another-value');
            expect(yield* secrets.get('EXISTING_KEY')).toBe('existing-value');
            expect(yield* secrets.get('ANOTHER_KEY')).toBe('another-value');
          }),
        );
      }).pipe(withEnv({})),
  );

  it.effect(
    'merges overlapping set() calls instead of one silently dropping the other',
    () =>
      Effect.gen(function* () {
        yield* withSecretsRootEffect(({ secretsPath }) =>
          Effect.gen(function* () {
            const secrets = new CliSecrets(secretsPath);

            // Two overlapping mutations on the same instance, started before
            // either resolves. Without intra-process serialization, each opens
            // its own JsonStore off the same on-disk snapshot and the later
            // flush silently drops the other's key.
            yield* Effect.all(
              [
                secrets.set('KEY_A', 'value-a'),
                secrets.set('KEY_B', 'value-b'),
                secrets.set('ORDERED_KEY', 'old-value'),
                secrets.set('ORDERED_KEY', 'new-value'),
              ],
              { concurrency: 'unbounded' },
            );

            expect(yield* secrets.get('KEY_A')).toBe('value-a');
            expect(yield* secrets.get('KEY_B')).toBe('value-b');
            expect(yield* secrets.get('ORDERED_KEY')).toBe('new-value');
          }),
        );
      }).pipe(withEnv({})),
  );

  it.effect(
    'ignores a non-string stored value instead of returning it as a key',
    () =>
      Effect.gen(function* () {
        yield* withSecretsRootEffect(({ secretsPath }) =>
          Effect.gen(function* () {
            const secrets = new CliSecrets(secretsPath);
            yield* secrets.set('GOOD_KEY', 'good-value');
            yield* Effect.promise(() =>
              fs.writeFile(
                secretsPath,
                JSON.stringify({
                  GOOD_KEY: 'good-value',
                  BAD_KEY: { nested: true },
                }),
                'utf8',
              ),
            );

            expect(yield* secrets.get('GOOD_KEY')).toBe('good-value');
            expect(yield* secrets.get('BAD_KEY')).toBeUndefined();
          }),
        );
      }),
  );

  itPosix(
    'reads nothing stored when the storage directory cannot be created',
    () =>
      Effect.gen(function* () {
        yield* withSecretsRootEffect(({ root, secretsPath }) =>
          // An inner scope so the restore runs when this body exits — before
          // withTempDirEffect's release removes the directory, exactly where
          // the original try/finally ran.
          Effect.scoped(
            Effect.gen(function* () {
              // `storage/` does not exist and its parent is unwritable, so any
              // open-time `mkdir`/`chmod` on the read path throws (#8220). Reads must
              // degrade to "nothing stored" so env-var credentials keep working.
              yield* Effect.promise(() => fs.chmod(root, 0o500));
              yield* Effect.addFinalizer(() =>
                Effect.promise(() => fs.chmod(root, 0o700)),
              );

              const secrets = new CliSecrets(secretsPath);

              expect(
                yield* secrets.get('TEXRA_CLI_SECRETS_MISSING_KEY'),
              ).toBeUndefined();
              expect(yield* secrets.listStoredKeys()).toEqual([]);
            }),
          ),
        );
      }),
  );

  itPosix('restricts the secrets file and its directory to the owner', () =>
    Effect.gen(function* () {
      yield* withSecretsRootEffect(({ secretsPath }) =>
        Effect.gen(function* () {
          const secrets = new CliSecrets(secretsPath);
          yield* secrets.set('TEXRA_CLI_SECRETS_TEST_KEY', 'test-key');

          const fileStat = yield* Effect.promise(() => fs.stat(secretsPath));
          const dirStat = yield* Effect.promise(() =>
            fs.stat(path.dirname(secretsPath)),
          );
          expect(fileStat.mode & 0o777).toBe(0o600);
          expect(dirStat.mode & 0o777).toBe(0o700);
        }),
      );
    }),
  );

  it('keeps one process-wide secrets store after the first root is selected', async () => {
    vi.resetModules();
    const { getCliSecrets } = await import('@cli/runtime/cliSecrets');

    await withSecretsRoot(async ({ root, storageRoot }) => {
      const first = getCliSecrets(storageRoot);
      const second = getCliSecrets(path.join(root, 'other-storage'));

      expect(second).toBe(first);
    });
  });
});
