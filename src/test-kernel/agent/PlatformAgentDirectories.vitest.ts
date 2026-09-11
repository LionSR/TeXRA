// Node imports
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { platform } from '@platform/platform';
import {
  fakeProcessServices,
  setupPlatform,
} from '@test/support/setupPlatform';
import {
  createTempDirPlatform,
  makeTempDir,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { GlobalStorageFS } from '@utils/files/storageFS';

const SYNC_MARKER_FILE = '.bundled-agent-sync.json';
const VERSION_STATE_KEY = 'lastKnownVersion';

const logs = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@logger/logUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@logger/logUtils')>();
  return { ...actual, createLog: () => logs };
});

const { bootstrapPlatformAgentDirectories } =
  await import('@agent/index/platformAgentDirectories');

function elocked(message: string): Error {
  return Object.assign(new Error(message), { code: 'ELOCKED' });
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

describe('bootstrapPlatformAgentDirectories', () => {
  const tempDirs = useTempDirs();
  let resourcesPath: string;

  setupPlatform(() => createTempDirPlatform('texra-agent-sync-', tempDirs));

  beforeEach(async () => {
    vi.clearAllMocks();
    resourcesPath = join(
      await makeTempDir('texra-agent-bundle-', tempDirs),
      'resources',
    );
    await Promise.all([
      writeText(join(resourcesPath, 'agents', 'writer.yaml'), 'name: writer\n'),
      writeText(
        join(resourcesPath, 'tool_use_agents', 'researcher.yaml'),
        'name: researcher\n',
      ),
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The bootstrap program over the fake host's process services: the suite
   *  runs it on the `it.effect` runtime, not a process runtime. */
  function bootstrap(currentVersion: string | undefined = '1.0.0') {
    return Effect.provide(
      bootstrapPlatformAgentDirectories({
        channel: 'test',
        resourcesPath,
        currentVersion,
        versionStateKey: VERSION_STATE_KEY,
      }),
      fakeProcessServices(),
    );
  }

  it.effect('serializes concurrent copies into the same storage root', () =>
    Effect.gen(function* () {
      const copied: string[] = [];
      let activeCopies = 0;
      let maxActiveCopies = 0;

      vi.spyOn(platform().fs, 'copy').mockImplementation(
        async (source, destination) => {
          activeCopies += 1;
          maxActiveCopies = Math.max(maxActiveCopies, activeCopies);
          try {
            await sleep(20);
            await writeText(join(destination, 'agent.yaml'), 'name: agent\n');
            copied.push(basename(source));
          } finally {
            activeCopies -= 1;
          }
        },
      );

      const first = yield* Effect.forkChild(bootstrap());
      const second = yield* Effect.forkChild(bootstrap());
      const third = yield* Effect.forkChild(bootstrap());
      const results = [
        yield* Fiber.join(first),
        yield* Fiber.join(second),
        yield* Fiber.join(third),
      ];

      expect(results).toEqual([true, true, true]);
      expect(maxActiveCopies).toBe(1);
      expect(copied).toEqual([
        'agents',
        'tool_use_agents',
        'agents',
        'tool_use_agents',
        'agents',
        'tool_use_agents',
      ]);
    }),
  );

  // `it.live`: the contention retry runs on the exponential-backoff schedule,
  // whose delays the TestClock `it.effect` installs would never advance.
  it.live(
    'retries contention and rechecks the marker after acquiring the shared lock',
    () =>
      Effect.gen(function* () {
        const copy = vi.spyOn(platform().fs, 'copy');
        const markerPath = GlobalStorageFS.fullPath(SYNC_MARKER_FILE);
        const withFileLock = vi
          .spyOn(platform().fileLocks, 'withFileLock')
          .mockImplementationOnce(
            () => () => Effect.fail(elocked('Lock file is already being held')),
          )
          .mockImplementationOnce((lockPath) => (self) => {
            expect(lockPath).toBe(markerPath);
            // Another process finished the same reconciliation while this one
            // waited for the lock; its marker must be honoured.
            return Effect.promise(() =>
              writeText(
                lockPath,
                `${JSON.stringify({
                  completedAt: Date.now(),
                  ownerPid: process.pid + 1,
                  version: '1.0.0',
                })}\n`,
              ),
            ).pipe(Effect.andThen(self));
          });

        yield* bootstrap('1.0.0');

        expect(copy).not.toHaveBeenCalled();
        expect(platform().globalState.get<string>(VERSION_STATE_KEY)).toBe(
          '1.0.0',
        );
        expect(withFileLock).toHaveBeenCalledTimes(2);
      }),
  );

  // `it.live`: the retry backoff must be drained through vitest's fake
  // timers on the real clock, not the TestClock.
  it.live(
    'skips refresh when cross-process ownership remains unavailable',
    () =>
      Effect.gen(function* () {
        // Leave `setImmediate` real: Effect schedules fiber resumptions
        // through it, so faking it would park the forked fiber before the
        // first attempt and nothing would ever arm a retry timer to drain.
        vi.useFakeTimers({
          toFake: [
            'setTimeout',
            'clearTimeout',
            'setInterval',
            'clearInterval',
            'Date',
          ],
        });
        // Signals that the first attempt failed, so its retry timer is armed
        // before `runAllTimersAsync` starts draining — the fiber keeps running
        // until it parks in the backoff sleep, so the timer exists by then.
        const firstAttempt = yield* Deferred.make<void>();
        const withFileLock = vi
          .spyOn(platform().fileLocks, 'withFileLock')
          .mockImplementation(
            () => () =>
              Deferred.succeed(firstAttempt, undefined).pipe(
                Effect.andThen(
                  Effect.fail(elocked('Lock file is already being held')),
                ),
              ),
          );

        const bootstrapped = yield* Effect.forkChild(bootstrap());
        yield* Deferred.await(firstAttempt);
        yield* Effect.promise(() => vi.runAllTimersAsync());
        expect(yield* Fiber.join(bootstrapped)).toBe(false);

        expect(withFileLock).toHaveBeenCalledTimes(21);
        expect(logs.warn).toHaveBeenCalledWith(
          'Skipping bundled agent refresh because another process still owns the sync lock',
        );
        expect(logs.error).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'does not mistake an in-operation ELOCKED failure for lock contention',
    () =>
      Effect.gen(function* () {
        const copy = vi
          .spyOn(platform().fs, 'copy')
          .mockResolvedValue(undefined);
        vi.spyOn(platform().globalState, 'update').mockRejectedValue(
          elocked('version store lock failed'),
        );

        yield* bootstrap();

        expect(copy).toHaveBeenCalledTimes(2);
        expect(logs.error).toHaveBeenCalledWith(
          expect.stringContaining('version store lock failed'),
        );
        expect(logs.warn).not.toHaveBeenCalled();
      }),
  );

  it.effect('does not fail reconciliation when the marker write fails', () =>
    Effect.gen(function* () {
      const copy = vi.spyOn(platform().fs, 'copy').mockResolvedValue(undefined);
      const writeFileImpl = platform().fs.writeFile.bind(platform().fs);
      vi.spyOn(platform().fs, 'writeFile').mockImplementation(
        async (target, content) => {
          if (target.endsWith(SYNC_MARKER_FILE)) {
            throw new Error('marker unwritable');
          }
          await writeFileImpl(target, content);
        },
      );

      yield* bootstrap();

      expect(copy).toHaveBeenCalledTimes(2);
      expect(platform().globalState.get<string>(VERSION_STATE_KEY)).toBe(
        '1.0.0',
      );
      expect(logs.warn).toHaveBeenCalledWith(
        'Failed to write bundled agent sync marker: marker unwritable',
      );
      expect(logs.error).not.toHaveBeenCalled();
    }),
  );

  it.effect('reports a copy failure without aborting host startup', () =>
    Effect.gen(function* () {
      vi.spyOn(platform().fs, 'copy').mockRejectedValue(
        new Error('copy failed'),
      );

      expect(yield* bootstrap()).toBe(false);

      expect(logs.error).toHaveBeenCalledWith(
        expect.stringContaining('copy failed'),
      );
    }),
  );
});
