import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { FileSecrets, secretsDirectory } from '@platform/defaults/fileSecrets';
import { withTempDirEffect } from '@test/support/tempDirPlatform';

function withStoreEffect<A, E, R>(
  run: (paths: { root: string; directory: string }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return withTempDirEffect('texra-file-secrets-', (root) =>
    run({ root, directory: secretsDirectory(path.join(root, 'storage')) }),
  );
}

const store = (directory: string) => new FileSecrets(directory, () => {});

describe('FileSecrets', () => {
  // POSIX file modes don't exist on Windows. skipIf (rather than an early
  // return) so the skip is visible in reports instead of a zero-assertion pass.
  const itPosix = it.effect.skipIf(process.platform === 'win32');

  // Several hosts and the service share the store: two handles stand in
  // for two processes, which share no lane.
  it.effect('keeps every key two handles write at once', () =>
    withStoreEffect(({ directory }) =>
      Effect.gen(function* () {
        const extension = store(directory);
        const service = store(directory);
        yield* Effect.all(
          [
            extension.set('apiKey.openai', 'sk-a'),
            service.set('apiKey.anthropic', 'sk-b'),
            extension.set('ordered', 'old'),
            extension.set('ordered', 'new'),
          ],
          { concurrency: 'unbounded' },
        );
        expect(yield* service.get('apiKey.openai')).toBe('sk-a');
        expect(yield* extension.get('apiKey.anthropic')).toBe('sk-b');
        expect(yield* service.get('ordered')).toBe('new');
        expect([...(yield* service.listStoredKeys())].sort()).toEqual([
          'apiKey.anthropic',
          'apiKey.openai',
          'ordered',
        ]);
        yield* service.delete('ordered');
        expect(yield* extension.get('ordered')).toBeUndefined();
      }),
    ),
  );

  it.effect('names every key, whatever characters it holds', () =>
    withStoreEffect(({ directory }) =>
      Effect.gen(function* () {
        const secrets = store(directory);
        const keys = ['.hidden', 'a/b', 'oauth:chatgpt session', '%staged'];
        for (const key of keys) yield* secrets.set(key, key);
        for (const key of keys) expect(yield* secrets.get(key)).toBe(key);
        expect([...(yield* secrets.listStoredKeys())].sort()).toEqual(
          [...keys].sort(),
        );
      }),
    ),
  );

  itPosix('reads nothing stored when the directory cannot be created', () =>
    withStoreEffect(({ root, directory }) =>
      Effect.scoped(
        Effect.gen(function* () {
          // Env-var credentials keep working when the store is unreachable.
          yield* Effect.promise(() => fs.chmod(root, 0o500));
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => fs.chmod(root, 0o700)),
          );
          const secrets = store(directory);
          expect(yield* secrets.get('missing')).toBeUndefined();
          expect(yield* secrets.listStoredKeys()).toEqual([]);
        }),
      ),
    ),
  );

  itPosix('keeps each key file and the directory to the owner', () =>
    withStoreEffect(({ directory }) =>
      Effect.gen(function* () {
        yield* store(directory).set('apiKey.openai', 'sk-a');
        const file = yield* Effect.promise(() =>
          fs.stat(path.join(directory, 'apiKey.openai')),
        );
        const dir = yield* Effect.promise(() => fs.stat(directory));
        expect(file.mode & 0o777).toBe(0o600);
        expect(dir.mode & 0o777).toBe(0o700);
      }),
    ),
  );
});
