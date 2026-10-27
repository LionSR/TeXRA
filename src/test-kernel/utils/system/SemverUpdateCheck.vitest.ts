import { describe, expect } from 'vitest';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { it as effectIt } from '@effect/vitest';
import { Effect, Exit, Fiber, FileSystem, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { globalDatabaseLayer } from '@controllers/session/Database';
import { processOwnerId } from '@platform/defaults/nodeProcesses';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { globalValuesOver } from '@test/support/setupPlatform';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { updateCheckRecordsLayer } from '@texra/controllers/session/updateCheckRecords';
import {
  runDailyUpdateCheck,
  UpdateCheckRecords,
} from '@texra/utils/system/updateCheck';

describe('runDailyUpdateCheck', () => {
  const nowMs = Date.UTC(2026, 0, 1);
  const withRecords = <A, E>(
    program: Effect.Effect<A, E, UpdateCheckRecords | TestClock.TestClock>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const storage = yield* fs.makeTempDirectoryScoped({
          prefix: 'texra-update-check-',
        });
        // The test clock governs the program alone, not the handle: the
        // global-root handle is now held open for the process's life and
        // polls `data_version` every 250ms, so a day advanced on a clock
        // that fiber also sleeps on would step the poll a quarter-million
        // times. Built outside, it ticks on the live clock and the
        // throttle still sees whatever day the program says it is.
        return yield* Effect.andThen(TestClock.setTime(nowMs), program).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provide(
            updateCheckRecordsLayer.pipe(
              Layer.provide(
                globalValuesOver(
                  globalDatabaseLayer(storage).pipe(
                    Layer.provide(
                      ProcessIdentity.layer(processOwnerId(undefined)),
                    ),
                    Layer.provide(nodeSpawnerLayer),
                    Layer.orDie,
                  ),
                ),
              ),
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer));

  effectIt.live(
    'records an announced release before honoring interruption',
    () =>
      withRecords(
        Effect.gen(function* () {
          const records = yield* UpdateCheckRecords;
          const checking = yield* Effect.forkChild(
            Effect.withFiber((fiber) =>
              runDailyUpdateCheck({
                currentVersion: '1.0.0',
                host: 'desktop',
                notifyOnce: true,
                fetchLatest: Effect.succeed({
                  version: '1.1.0',
                  refreshed: true,
                }),
                notify: () => Effect.sync(() => fiber.interruptUnsafe()),
              }),
            ),
          );
          expect(Exit.isFailure(yield* Fiber.await(checking))).toBe(true);
          expect(yield* records.read('desktop')).toEqual({
            lastNotifiedVersion: '1.1.0',
            lastCheckedAt: null,
          });
        }),
      ),
  );
});
