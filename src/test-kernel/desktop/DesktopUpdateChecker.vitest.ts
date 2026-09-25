import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, FileSystem, Layer } from 'effect';
import { describe, expect, vi } from 'vitest';
import { globalDatabaseLayer } from '@controllers/session/Database';
import { updateCheckRecordsLayer } from '@controllers/session/updateCheckRecords';
import {
  checkForDesktopUpdate,
  DESKTOP_RELEASES_PAGE_URL,
} from '@desktop/main/desktopUpdateChecker';
import { processOwnerId } from '@platform/defaults/nodeProcesses';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { UpdateCheckRecords } from '@shared/session/updateCheckRecords';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { withEnv } from '@test/support/testEnv';

import type { HttpClient } from 'effect/unstable/http';

type Options = Parameters<typeof checkForDesktopUpdate>[0];
const release = { version: '0.40.0' };
const runCheck = (
  overrides: Partial<Options> = {},
  env: Record<string, string> = {},
) =>
  checkForDesktopUpdate({
    currentVersion: '0.39.3',
    isPackaged: true,
    notify: () => {},
    fetchRelease: Effect.succeed(release),
    ...overrides,
  }).pipe(withEnv(env));
const withRecords = <A, E>(
  program: Effect.Effect<A, E, UpdateCheckRecords | HttpClient.HttpClient>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const storage = yield* fs.makeTempDirectoryScoped({
        prefix: 'texra-desktop-update-',
      });
      return yield* program.pipe(
        Effect.provide(
          updateCheckRecordsLayer.pipe(
            Layer.provide(
              globalDatabaseLayer(storage).pipe(
                Layer.provide(ProcessIdentity.layer(processOwnerId(undefined))),
                Layer.orDie,
              ),
            ),
          ),
        ),
      );
    }),
  ).pipe(
    Effect.provide(Layer.merge(NodeFileSystem.layer, testHttpClientLayer)),
  );

describe('desktop update checker', () => {
  it.live('skips entirely for unpackaged (dev) runs', () =>
    withRecords(
      Effect.gen(function* () {
        const notify = vi.fn();
        const fetchRelease = vi.fn(() => release);
        yield* runCheck({
          isPackaged: false,
          notify,
          fetchRelease: Effect.sync(fetchRelease),
        });
        expect(fetchRelease).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
      }),
    ),
  );
  it.live('skips entirely when TEXRA_NO_UPDATE_CHECK is set', () =>
    withRecords(
      Effect.gen(function* () {
        const fetchRelease = vi.fn(() => release);
        yield* runCheck(
          { fetchRelease: Effect.sync(fetchRelease) },
          { TEXRA_NO_UPDATE_CHECK: '1' },
        );
        expect(fetchRelease).not.toHaveBeenCalled();
      }),
    ),
  );
  it.live(
    'notifies once when a newer release is found, and persists the notified version',
    () =>
      withRecords(
        Effect.gen(function* () {
          const records = yield* UpdateCheckRecords;
          const notify = vi.fn();
          yield* runCheck({ notify });
          expect(notify).toHaveBeenCalledExactlyOnceWith(release);
          expect((yield* records.read('desktop'))?.lastNotifiedVersion).toBe(
            '0.40.0',
          );
        }),
      ),
  );
  it.live('coalesces concurrent checks into one fetch and notification', () =>
    withRecords(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const pending = yield* Deferred.make<typeof release>();
        const fetched = vi.fn();
        const fetchRelease = Effect.gen(function* () {
          fetched();
          yield* Deferred.succeed(started, undefined);
          return yield* Deferred.await(pending);
        });
        const firstNotify = vi.fn();
        const secondNotify = vi.fn();
        const first = yield* Effect.forkChild(
          runCheck({ notify: firstNotify, fetchRelease }),
        );
        yield* Deferred.await(started);
        yield* runCheck({ notify: secondNotify, fetchRelease });
        expect(fetched).toHaveBeenCalledOnce();
        yield* Deferred.succeed(pending, release);
        yield* Fiber.join(first);
        expect(fetched).toHaveBeenCalledOnce();
        expect(firstNotify).not.toHaveBeenCalled();
        expect(secondNotify).toHaveBeenCalledOnce();
      }),
    ),
  );
});
