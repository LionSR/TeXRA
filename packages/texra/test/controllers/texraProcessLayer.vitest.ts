/**
 * Failure modes: a process without a GUI/chat installs no credential watch;
 * repeated external writes stop arriving; a disposed process keeps watching
 * when another process opens the same storage root.
 */
import { join, resolve } from 'node:path';

import { it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Queue, Scope, Stream } from 'effect';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { expect } from 'vitest';

import { FileSecrets, secretsDirectory } from '@texra-ai/harness/node';
import { AppSignals, Secrets } from '@texra-ai/harness/plugins';
import { texraProcessLayer } from '@texra/controllers/texraProcessLayer';
import { withTempDirEffect } from '@test/support/tempDirPlatform';

it.live(
  'follows external credentials for the process lifetime, without a window',
  () =>
    withTempDirEffect('texra-process-credentials-', (root) =>
      Effect.gen(function* () {
        const dispatcher = getGlobalDispatcher();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => setGlobalDispatcher(dispatcher)),
        );
        const storageRoot = join(root, 'storage');
        const external = new FileSecrets(
          secretsDirectory(storageRoot),
          () => {},
        );
        const previous: string[][] = [];
        for (const cycle of [0, 1]) {
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const context = yield* Layer.buildWithScope(
            texraProcessLayer({
              name: 'cli',
              storageRoot,
              resourcesPath: resolve('packages/extension/resources'),
              usageLog: { version: 'test', editorType: 'cli' },
              minimumLogLevel: 'None',
            }),
            scope,
          );
          const signals = Context.get(context, AppSignals);
          const secrets = Context.get(context, Secrets);
          const changes = Stream.fromSubscription(yield* signals.subscribe);
          const received: string[] = [];
          const key = `watch.${cycle}`;
          const values = yield* Queue.unbounded<string | undefined>();
          // The observer outlives the process so a leaked watch remains visible.
          yield* changes.pipe(
            Stream.runForEach(({ signal, payload }) => {
              if (
                signal !== 'credentialChanged' ||
                !payload ||
                !('key' in payload)
              )
                return Effect.void;
              received.push(payload.key);
              return payload.key === key
                ? secrets
                    .get(key)
                    .pipe(Effect.flatMap((value) => Queue.offer(values, value)))
                : Effect.void;
            }),
            Effect.forkScoped,
          );
          const closedCounts = previous.map((keys) => keys.length);
          for (const value of ['first', 'replacement', undefined]) {
            if (value === undefined) yield* external.delete(key);
            else yield* external.set(key, value);
            yield* Stream.fromQueue(values).pipe(
              Stream.filter((observed) => observed === value),
              Stream.take(1),
              Stream.runDrain,
              Effect.timeout('2 seconds'),
            );
            expect(yield* secrets.get(key)).toBe(value);
          }
          expect(previous.map((keys) => keys.length)).toEqual(closedCounts);
          yield* Scope.close(scope, Exit.void);
          previous.push(received);
        }
      }),
    ),
);
