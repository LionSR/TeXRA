import { NodeFileSystem } from '@effect/platform-node';
import * as NodeSocketServer from '@effect/platform-node/NodeSocketServer';
import { it } from '@effect/vitest';
import { Effect, Exit, FileSystem, Layer, Scope, Stream } from 'effect';
import { RpcSerialization, RpcServer } from 'effect/rpc';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vitest';

import { globalDatabaseLayer } from '@controllers/session/globalDatabaseLayer';
import { globalValuesOver, nodePlatformLayer } from '@test/support/fsTestUtils';
import { linkService } from '@texra/controllers/server/client';
import {
  claimServiceRecord,
  servicePaths,
} from '@texra/controllers/server/discovery';
import {
  BUILD_VERSION,
  PROTOCOL,
  TexraRpcs,
} from '@texra/controllers/server/protocol';

/**
 * A service that answers the hello on its own socket under `storageRoot`
 * and holds the record, started at `startedAt` on the test clock. Closing
 * `scope` ends it as a kill does: the socket closes, the record stays.
 */
const fakeService = Effect.fn('fakeService')(function* (
  storageRoot: string,
  startedAt: number,
  scope: Scope.Scope,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = servicePaths(storageRoot);
  yield* fs.makeDirectory(paths.socketDirectory, { recursive: true });
  const socket = paths.socketFor(process.pid);
  const info = {
    protocol: PROTOCOL.digest,
    version: BUILD_VERSION,
    pid: process.pid,
    socket,
    startedAt,
    clients: 0,
    running: 0,
    draining: false,
  };
  yield* RpcServer.make(TexraRpcs).pipe(
    Effect.provide(
      Layer.merge(
        TexraRpcs.toLayerHandler(
          'service.hello',
          Effect.succeed(() => Effect.succeed(info)),
        ),
        RpcServer.layerProtocolSocketServer.pipe(
          Layer.provide(RpcSerialization.layerNdjson),
          Layer.provide(NodeSocketServer.layer({ path: socket })),
        ),
      ),
    ),
    // cast: the link asks this service only for its hello; the other
    // procedures have no handler here.
    (served) => served as Effect.Effect<never, never, never>,
    Effect.forkIn(scope),
  );
  yield* claimServiceRecord({ pid: process.pid, socket, startedAt }, () =>
    Effect.succeed(null),
  );
});

describe('linkService', () => {
  // The service does not run on Windows yet: `linkService` refuses there
  // before it starts anything (`WINDOWS_UNSUPPORTED`), so there is no
  // restart to bound.
  it.effect.skipIf(process.platform === 'win32')(
    'stops restarting a service that never comes up, and says so with its log',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const storageRoot = yield* fs.makeTempDirectoryScoped({
          prefix: 'texra-link-',
        });
        const program = Effect.gen(function* () {
          const running = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(running, Exit.void));
          yield* fakeService(storageRoot, 1, running);
          // The scripted spawner: every start is of a service that exits
          // before it listens.
          let starts = 0;
          const link = yield* linkService(
            {
              storageRoot,
              start: Effect.sync(() => {
                starts += 1;
                return Effect.succeed('exited with code 1');
              }),
            },
            { startsService: true, waiting: () => Effect.void },
          );
          // The service ran for a while, then died: the link restarts it.
          yield* TestClock.adjust('10 minutes');
          yield* Scope.close(running, Exit.void);
          // Two hours of the link's waits, a second at a time, each with a
          // moment of real time for the socket and the store.
          yield* TestClock.adjust('1 second').pipe(
            Effect.andThen(TestClock.withLive(Effect.sleep('2 millis'))),
            Effect.repeat({ times: 7200 }),
            Effect.raceFirst(
              link.state.changes.pipe(
                Stream.filter((state) => 'away' in state && state.lasting),
                Stream.runHead,
              ),
            ),
          );
          const state = yield* link.state.get;
          const { log } = servicePaths(storageRoot);
          expect(starts).toBe(3);
          expect(state).toStrictEqual({
            client: null,
            away: `The TeXRA service failed to start 3 times in a row, so TeXRA stopped restarting it. The last failure: The TeXRA service exited with code 1 before it answered (its log: ${log}). Its log is ${log}. Fix what the log names, then restart TeXRA (in VS Code, reload the window); with TEXRA_NO_SERVICE=1 set, TeXRA runs tasks without the service.`,
            lasting: true,
          });
        });
        yield* program.pipe(
          Effect.provide(
            globalValuesOver(
              globalDatabaseLayer(storageRoot).pipe(
                Layer.provide(nodePlatformLayer),
                Layer.orDie,
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    60_000,
  );
});
