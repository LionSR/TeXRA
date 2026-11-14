import { describe, expect } from 'vitest';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { it as effectIt } from '@effect/vitest';
import { Effect, Exit, Fiber, FileSystem, Layer } from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { GlobalValues } from '@texra-ai/harness/host';
import { globalDatabaseLayer } from '@controllers/session/databaseLayer';
import { globalValuesOver } from '@test/support/setupPlatform';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { jsonResponse } from '@test/support/fetchTestUtils';
import { checkForDesktopUpdate } from '@desktop/main/desktopUpdateChecker';
import { UPDATE_CHECKS } from '@texra/utils/system/updateCheck';

describe('checkForDesktopUpdate', () => {
  const nowMs = Date.UTC(2026, 0, 1);
  /** The releases API, answering with release 1.1.0. */
  const releases = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch)(() =>
        Promise.resolve(jsonResponse({ tag_name: 'v1.1.0' })),
      ),
    ),
  );
  const withRecords = <A, E>(
    program: Effect.Effect<
      A,
      E,
      GlobalValues | HttpClient.HttpClient | TestClock.TestClock
    >,
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
          Effect.provide(releases),
          Effect.provide(
            globalValuesOver(
              globalDatabaseLayer(storage).pipe(
                Layer.provide(nodeSpawnerLayer),
                Layer.orDie,
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
          const checking = yield* Effect.forkChild(
            Effect.withFiber((fiber) =>
              checkForDesktopUpdate({
                currentVersion: '1.0.0',
                isPackaged: true,
                notify: () => Effect.sync(() => fiber.interruptUnsafe()),
              }),
            ),
          );
          expect(Exit.isFailure(yield* Fiber.await(checking))).toBe(true);
          const values = yield* GlobalValues;
          expect(yield* values.get(UPDATE_CHECKS, 'desktop')).toEqual({
            lastNotifiedVersion: '1.1.0',
            lastCheckedAt: null,
          });
        }),
      ),
  );
});
