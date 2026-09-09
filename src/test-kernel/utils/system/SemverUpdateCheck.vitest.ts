import { describe, expect, it, vi } from 'vitest';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { it as effectIt } from '@effect/vitest';
import { Effect, Exit, Fiber, FileSystem, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { updateCheckRecordsLayer } from '@controllers/session/updateCheckRecords';
import { processOwnerId } from '@platform/defaults/nodeProcesses';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { UpdateCheckRecords } from '@shared/session/updateCheckRecords';
import { isNewerSemverVersion } from '@utils/system/semverUpdateCheck';
import {
  fetchJsonStringField,
  runDailyUpdateCheck,
} from '@utils/system/updateCheck';

describe('isNewerSemverVersion', () => {
  it('compares numerically across all components', () => {
    expect(isNewerSemverVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerSemverVersion('0.39.0', '0.38.2')).toBe(true);
    expect(isNewerSemverVersion('0.38.3', '0.38.2')).toBe(true);
    expect(isNewerSemverVersion('0.38.2', '0.38.2')).toBe(false);
    expect(isNewerSemverVersion('0.38.1', '0.38.2')).toBe(false);
  });

  it('ranks a release above its prerelease but not vice versa', () => {
    expect(isNewerSemverVersion('1.2.0', '1.2.0-rc.1')).toBe(true);
    expect(isNewerSemverVersion('1.2.0-rc.1', '1.2.0')).toBe(false);
    expect(isNewerSemverVersion('1.2.0-rc.2', '1.2.0-rc.1')).toBe(true);
  });

  it('returns false when either version is unparseable', () => {
    expect(isNewerSemverVersion('1.0.0', 'unknown')).toBe(false);
    expect(isNewerSemverVersion('latest', '1.0.0')).toBe(false);
    expect(isNewerSemverVersion('not-a-version', '0.39.3')).toBe(false);
    expect(isNewerSemverVersion('0.40.0', 'not-a-version')).toBe(false);
  });
});

describe('runDailyUpdateCheck', () => {
  const nowMs = Date.UTC(2026, 0, 1);
  type CheckOptions = Parameters<typeof runDailyUpdateCheck>[0];
  const checkOptions = (
    overrides: Partial<CheckOptions> = {},
  ): CheckOptions => ({
    currentVersion: '1.0.0',
    host: 'desktop',
    fetchLatest: Effect.succeed({ version: '1.0.0', refreshed: true }),
    notify: () => Effect.void,
    ...overrides,
  });
  const withRecords = <A, E>(
    program: Effect.Effect<A, E, UpdateCheckRecords | TestClock.TestClock>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const storage = yield* fs.makeTempDirectoryScoped({
          prefix: 'texra-update-check-',
        });
        yield* TestClock.setTime(nowMs);
        return yield* program.pipe(
          Effect.provide(
            updateCheckRecordsLayer(() => storage).pipe(
              Layer.provide(ProcessIdentity.layer(processOwnerId(undefined))),
            ),
          ),
        );
      }),
    ).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(TestClock.layer()),
    );

  effectIt.live('notifies before stamping a successful live check', () =>
    withRecords(
      Effect.gen(function* () {
        const records = yield* UpdateCheckRecords;
        let stampDuringNotify: number | null | undefined;
        const latest = yield* runDailyUpdateCheck(
          checkOptions({
            fetchLatest: Effect.succeed({ version: '1.1.0', refreshed: true }),
            notify: () =>
              Effect.gen(function* () {
                stampDuringNotify = (yield* records.read('desktop'))
                  ?.lastCheckedAt;
              }),
          }),
        );
        expect(latest).toBe('1.1.0');
        expect(stampDuringNotify).toBeUndefined();
        expect((yield* records.read('desktop'))?.lastCheckedAt).toBe(nowMs);
      }),
    ),
  );

  effectIt.live(
    'does not repeat a release notification but still stamps a live refresh',
    () =>
      withRecords(
        Effect.gen(function* () {
          const records = yield* UpdateCheckRecords;
          yield* records.recordNotified('desktop', '1.1.0');
          const notify = vi.fn(() => Effect.void);
          yield* runDailyUpdateCheck(
            checkOptions({
              notifyOnce: true,
              fetchLatest: Effect.succeed({
                version: '1.1.0',
                refreshed: true,
              }),
              notify,
            }),
          );
          expect(notify).not.toHaveBeenCalled();
          expect((yield* records.read('desktop'))?.lastCheckedAt).toBe(nowMs);
        }),
      ),
  );

  effectIt.live('throttles a repeat check within the same day', () =>
    withRecords(
      Effect.gen(function* () {
        const fetchLatest = vi.fn(() => ({
          version: '1.0.0',
          refreshed: true,
        }));
        const options = checkOptions({ fetchLatest: Effect.sync(fetchLatest) });
        yield* runDailyUpdateCheck(options);
        expect(fetchLatest).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust('10 minutes');
        yield* runDailyUpdateCheck(options);
        expect(fetchLatest).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust('24 hours');
        yield* runDailyUpdateCheck(options);
        expect(fetchLatest).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  effectIt.live('does not notify when the latest version is not newer', () =>
    withRecords(
      Effect.gen(function* () {
        const records = yield* UpdateCheckRecords;
        const notify = vi.fn(() => Effect.void);
        expect(
          yield* runDailyUpdateCheck(checkOptions({ notify })),
        ).toBeUndefined();
        expect(notify).not.toHaveBeenCalled();
        expect((yield* records.read('desktop'))?.lastCheckedAt).toBe(nowMs);
      }),
    ),
  );

  effectIt.live(
    'retries a failed release notification before recording it as notified',
    () =>
      withRecords(
        Effect.gen(function* () {
          const records = yield* UpdateCheckRecords;
          const failure = new Error('dialog failed');
          const notify = vi
            .fn<CheckOptions['notify']>(() => Effect.void)
            .mockReturnValueOnce(Effect.fail(failure));
          const options = checkOptions({
            notifyOnce: true,
            fetchLatest: Effect.succeed({ version: '1.1.0', refreshed: true }),
            notify,
          });
          expect(yield* Effect.flip(runDailyUpdateCheck(options))).toBe(
            failure,
          );
          expect(yield* records.read('desktop')).toBeNull();
          expect(yield* runDailyUpdateCheck(options)).toBe('1.1.0');
          expect(notify).toHaveBeenCalledTimes(2);
          expect((yield* records.read('desktop'))?.lastNotifiedVersion).toBe(
            '1.1.0',
          );
        }),
      ),
  );

  effectIt.live(
    'records an announced release before honoring interruption',
    () =>
      withRecords(
        Effect.gen(function* () {
          const records = yield* UpdateCheckRecords;
          const checking = yield* Effect.forkChild(
            Effect.withFiber((fiber) =>
              runDailyUpdateCheck(
                checkOptions({
                  notifyOnce: true,
                  fetchLatest: Effect.succeed({
                    version: '1.1.0',
                    refreshed: true,
                  }),
                  notify: () => Effect.sync(() => fiber.interruptUnsafe()),
                }),
              ),
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

  effectIt.live(
    'can offer stale source metadata without stamping the check',
    () =>
      withRecords(
        Effect.gen(function* () {
          const records = yield* UpdateCheckRecords;
          const notify = vi.fn(() => Effect.void);
          yield* runDailyUpdateCheck(
            checkOptions({
              fetchLatest: Effect.succeed({
                version: '1.1.0',
                refreshed: false,
              }),
              notify,
            }),
          );
          expect(notify).toHaveBeenCalledWith('1.1.0');
          expect(yield* records.read('desktop')).toBeNull();
        }),
      ),
  );

  effectIt.live(
    'applies the host policy when the throttle stamp cannot be persisted',
    () =>
      withRecords(
        Effect.gen(function* () {
          const records = yield* UpdateCheckRecords;
          const failure = new Error('read-only state');
          const layer = Layer.succeed(UpdateCheckRecords)({
            ...records,
            recordChecked: () => Effect.fail(failure),
          });
          const options = checkOptions({
            fetchLatest: Effect.succeed({ version: '1.1.0', refreshed: true }),
          });
          expect(
            yield* runDailyUpdateCheck({
              ...options,
              stampFailure: 'ignore',
            }).pipe(Effect.provide(layer)),
          ).toBe('1.1.0');
          expect(
            yield* Effect.flip(
              runDailyUpdateCheck(options).pipe(Effect.provide(layer)),
            ),
          ).toBe(failure);
        }),
      ),
  );
});

describe('fetchJsonStringField', () => {
  effectIt.effect('rejects an empty string field', () =>
    Effect.gen(function* () {
      const fetchImpl = vi.fn(async () =>
        Response.json({ version: '' }),
      ) as unknown as typeof fetch;
      expect(
        yield* fetchJsonStringField({
          url: 'https://example.test/latest',
          field: 'version',
          timeoutMs: 1000,
          fetchImpl,
        }),
      ).toBeUndefined();
    }),
  );
});
