import { it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { afterEach, beforeEach, describe, expect, vi, type Mock } from 'vitest';

import { SupabaseAuth } from '@auth/SupabaseAuth';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { AgentCategory, TELEMETRY_ENABLED_KEY } from '@shared/schemas';
import { UsageLog } from '@shared/usageLog';
import {
  usageLogLayer,
  type UsageLogOptions,
} from '@telemetry/UsageLogService';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createDeferred } from '@test/support/asyncTestUtils';
import { FakeScopedConfigProvider } from '@test/support/FakePlatform';
import {
  jsonResponse,
  testHttpClientLayer,
} from '@test/support/fetchTestUtils';
import { fakeSupabaseAuth } from '@test/support/fakeSupabaseAuth';
import { installHostAuth, setupPlatform } from '@test/support/setupPlatform';

function usageEntry(model: string) {
  return {
    model,
    provider: 'openai-chat' as const,
    agentName: 'agent',
    agentCategory: AgentCategory.ToolUse,
    inputTokens: 1,
    outputTokens: 1,
    cost: 0.001,
  };
}

function batchModels(batch: unknown): string[] {
  const entries = (batch as { entries: Array<{ model: string }> }).entries;
  return entries.map((entry) => entry.model);
}

function batchId(batch: unknown): string {
  return (batch as { batchId: string }).batchId;
}

function stubAccessToken(): void {
  installHostAuth(fakeSupabaseAuth({ accessToken: Effect.succeed('token') }));
}

// The Effect fetch client passes (url, init); read each batch body from the
// init. `beforeRespond` lets a test stall or fail a specific call before the
// success response.
function stubFetch(
  batches: unknown[],
  beforeRespond: (
    callCount: number,
  ) => void | Response | Promise<void | Response> = () => {},
): Mock {
  const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
    batches.push(await new Response(init.body).json());
    const response = await beforeRespond(fetchMock.mock.calls.length);
    return response ?? jsonResponse({ success: true, accepted: 1 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubBatchFetch(
  beforeRespond: (
    callCount: number,
  ) => void | Response | Promise<void | Response> = () => {},
): { batches: unknown[]; fetchMock: Mock } {
  const batches: unknown[] = [];
  return { batches, fetchMock: stubFetch(batches, beforeRespond) };
}

describe('UsageLogService', () => {
  // The service's lifetime is a layer the process runtime builds; a suite
  // owns one scope in its place, and closing it is what the host's runtime
  // disposal does.
  let lifetime: Scope.Closeable | undefined;
  let usageLog: UsageLog['Service'];

  const stopUsageLog = async (): Promise<void> => {
    const scope = lifetime;
    lifetime = undefined;
    if (scope) await testRuntime().runPromise(Scope.close(scope, Exit.void));
  };

  const startUsageLog = async (
    config: UsageLogOptions['config'],
    scope?: Scope.Closeable,
  ): Promise<void> => {
    await stopUsageLog();
    lifetime = scope ?? Scope.makeUnsafe();
    const context = await testRuntime().runPromise(
      Scope.provide(
        // The process runtime's diagnostics, which the service logs through.
        Layer.build(
          usageLogLayer({
            version: undefined,
            editorType: undefined,
            config,
          }).pipe(Layer.provide(effectDiagnosticsLayer('Trace'))),
        ),
        lifetime,
      ),
    );
    usageLog = Context.get(context, UsageLog);
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await startUsageLog({
      batchSize: 1,
      flushIntervalMs: 60_000,
      enabled: true,
    });
  });

  afterEach(async () => {
    await stopUsageLog();
    setLogSink(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('drains entries queued while another flush is in flight', async () => {
    stubAccessToken();

    const { promise: firstFetchReleased, resolve: releaseFirstFetch } =
      createDeferred();
    const { batches, fetchMock } = stubBatchFetch(async (callCount) => {
      if (callCount === 1) {
        await firstFetchReleased;
      }
    });

    usageLog.log(usageEntry('first'), testWorkspaceRoots().config);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    usageLog.log(usageEntry('second'), testWorkspaceRoots().config);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirstFetch();
    await vi.waitFor(() =>
      expect(batches.map(batchModels)).toEqual([['first'], ['second']]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits for successive active batches during disposal', async () => {
    stubAccessToken();

    const { promise: firstFetchReleased, resolve: releaseFirstFetch } =
      createDeferred();
    const { promise: secondFetchReleased, resolve: releaseSecondFetch } =
      createDeferred();
    const { batches, fetchMock } = stubBatchFetch(async (callCount) => {
      if (callCount === 1) await firstFetchReleased;
      if (callCount === 2) await secondFetchReleased;
    });

    usageLog.log(usageEntry('first'), testWorkspaceRoots().config);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    usageLog.log(usageEntry('second'), testWorkspaceRoots().config);
    const disposal = stopUsageLog();

    releaseFirstFetch();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseSecondFetch();
    await expect(disposal).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches.map(batchModels)).toEqual([['first'], ['second']]);
  });

  // The ticker only schedules; the process owns the sender independently.
  // Closing the scope must leave a send already in flight alone and wait
  // behind it, not abort the request and lose the batch it had already taken
  // from the queue.
  it('process scope closure joins a timer-driven send before stopping admission', async () => {
    stubAccessToken();
    const owner = Scope.makeUnsafe();
    await startUsageLog(
      { batchSize: 100, flushIntervalMs: 20, enabled: true },
      owner,
    );

    const { promise: fetchReleased, resolve: releaseFetch } = createDeferred();
    const { batches, fetchMock } = stubBatchFetch(async () => {
      await fetchReleased;
    });

    usageLog.log(usageEntry('timer'), testWorkspaceRoots().config);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;

    const disposal = stopUsageLog();
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    // Long enough for a dispose that abandons the send to have resolved.
    await vi.advanceTimersByTimeAsync(50);
    expect(init.signal?.aborted).toBe(false);
    expect(disposed).toBe(false);

    releaseFetch();
    await expect(disposal).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(batches.map(batchModels)).toEqual([['timer']]);
    usageLog.log(usageEntry('after-close'), testWorkspaceRoots().config);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The ticker must not keep a short-lived host alive by itself: a process
  // that starts the log and exits without disposing its runtime still exits
  // on an empty loop, so the ticker's timer is unref'd while the request a
  // flush sends holds the loop on its own.
  it('schedules the ticker on a timer that does not hold the event loop', async () => {
    vi.useRealTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await startUsageLog({
      batchSize: 100,
      flushIntervalMs: 12_345,
      enabled: true,
    });

    const tick = timers.mock.calls.findIndex(([, delay]) => delay === 12_345);
    expect(tick).toBeGreaterThanOrEqual(0);
    const handle = timers.mock.results[tick]?.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
  });

  it('keeps queued entries when the token read answers signed-out', async () => {
    // The token probe never rejects — an auth outage answers null — so the
    // outage case is a signed-out read: the flush skips without dequeuing,
    // and the next timer tick sends once a token exists.
    let tokenReads = 0;
    installHostAuth(
      fakeSupabaseAuth({
        accessToken: Effect.suspend(() =>
          Effect.succeed(tokenReads++ === 0 ? null : 'token'),
        ),
      }),
    );

    const { batches, fetchMock } = stubBatchFetch();

    usageLog.log(usageEntry('first'), testWorkspaceRoots().config);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(batches.map(batchModels)).toEqual([['first']]);
  });

  it.each([
    ['network failure', new Error('network unavailable')],
    ['malformed acknowledgement', { success: true }],
    [
      'retryable rejection',
      { success: false, accepted: 0, error: 'invalid batch' },
    ],
    ['partial acknowledgement', { success: true, accepted: 0 }],
  ])('requeues entries after a %s', async (_case, firstFailure) => {
    stubAccessToken();

    const { batches, fetchMock } = stubBatchFetch((callCount) => {
      if (callCount !== 1) return;
      if (firstFailure instanceof Error) throw firstFailure;
      return jsonResponse(firstFailure);
    });

    usageLog.log(usageEntry('first'), testWorkspaceRoots().config);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches.map(batchModels)).toEqual([['first'], ['first']]);
    expect(batchId(batches[1])).toBe(batchId(batches[0]));
  });

  it('discards a permanent rejection and continues with later entries', async () => {
    stubAccessToken();

    const { promise: rejectionReleased, resolve: releaseRejection } =
      createDeferred();
    const { batches, fetchMock } = stubBatchFetch(async (callCount) => {
      if (callCount === 2) throw new Error('network unavailable');
      if (callCount !== 1) return;
      await rejectionReleased;
      return jsonResponse({
        success: false,
        accepted: 0,
        error: 'invalid batch',
        retryable: false,
      });
    });

    usageLog.log(usageEntry('invalid'), testWorkspaceRoots().config);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    usageLog.log(usageEntry('valid'), testWorkspaceRoots().config);
    releaseRejection();

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches.map(batchModels)).toEqual([['invalid'], ['valid']]);
    expect(batchId(batches[1])).not.toBe(batchId(batches[0]));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(batches.map(batchModels)).toEqual([
      ['invalid'],
      ['valid'],
      ['valid'],
    ]);
    expect(batchId(batches[2])).toBe(batchId(batches[1]));
  });

  it('keeps a failed batch id separate from later queued entries', async () => {
    stubAccessToken();

    const { batches, fetchMock } = stubBatchFetch((callCount) => {
      if (callCount === 1) {
        throw new Error('network unavailable');
      }
    });

    usageLog.log(usageEntry('first'), testWorkspaceRoots().config);
    await vi.advanceTimersByTimeAsync(0);

    usageLog.log(usageEntry('second'), testWorkspaceRoots().config);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(batches.map(batchModels)).toEqual([
      ['first'],
      ['first'],
      ['second'],
    ]);
    expect(batchId(batches[1])).toBe(batchId(batches[0]));
    expect(batchId(batches[2])).not.toBe(batchId(batches[0]));
  });

  describe('texra.telemetry.enabled opt-out', () => {
    // These tests write to the config provider. Without a per-test platform the
    // mutation outlives the test — the file-scoped fake from setupFakePlatform
    // is shared — and a stray `enabled: false` silently disables logging for
    // every suite that runs afterwards.
    setupPlatform({}, { config: new FakeScopedConfigProvider() });

    // Optional entries must be discarded without a request.
    async function expectNoOptionalUsageSent(): Promise<void> {
      const { batches, fetchMock } = stubBatchFetch();

      usageLog.log(usageEntry('optional'), testWorkspaceRoots().config);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(batches).toEqual([]);
    }

    it.live('sends nothing while the setting is off', () =>
      Effect.gen(function* () {
        stubAccessToken();
        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          false,
          'global',
        );

        yield* Effect.promise(() => expectNoOptionalUsageSent());
      }),
    );

    it.live('honours a workspace-scoped telemetry opt-out', () =>
      Effect.gen(function* () {
        stubAccessToken();
        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          false,
          'workspace',
        );

        yield* Effect.promise(() => expectNoOptionalUsageSent());
      }),
    );

    it.live('does not let a project opt in over a user-wide opt-out', () =>
      Effect.gen(function* () {
        stubAccessToken();
        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          false,
          'global',
        );
        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          true,
          'workspace',
        );

        yield* Effect.promise(() => expectNoOptionalUsageSent());
      }),
    );

    // The setting is read live, so turning it off has to drop rounds already
    // queued under the old value rather than letting the next flush ship them.
    it.live('discards entries queued before the setting was turned off', () =>
      Effect.gen(function* () {
        stubAccessToken();
        yield* Effect.promise(() =>
          startUsageLog({ batchSize: 100, flushIntervalMs: 60_000 }),
        );

        const { batches, fetchMock } = stubBatchFetch();

        usageLog.log(usageEntry('before-opt-out'), testWorkspaceRoots().config);
        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          false,
          'global',
        );

        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));

        expect(fetchMock).not.toHaveBeenCalled();
        expect(batches).toEqual([]);
      }),
    );

    it.live('resumes sending once the setting is turned back on', () =>
      Effect.gen(function* () {
        stubAccessToken();
        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          false,
          'global',
        );

        const { batches, fetchMock } = stubBatchFetch();

        usageLog.log(usageEntry('dropped'), testWorkspaceRoots().config);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
        expect(fetchMock).not.toHaveBeenCalled();

        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          true,
          'global',
        );
        usageLog.log(usageEntry('sent'), testWorkspaceRoots().config);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(batches.map(batchModels)).toEqual([['sent']]);
      }),
    );

    // Plan accounting is derived from the aggregate that these records
    // populate, so an opt-out that suppressed them would let plan-covered
    // calls run on against a stale total. Only `api-key` rounds are optional.
    it.live.each([
      'chatgpt-subscription',
      'xai-subscription',
      'kimi-code-subscription',
      'glm-coding-plan-subscription',
    ] as const)('still sends %s usage while the setting is off', (usageRoute) =>
      Effect.gen(function* () {
        stubAccessToken();
        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          false,
          'global',
        );

        const { batches, fetchMock } = stubBatchFetch();

        usageLog.log(
          { ...usageEntry('hosted'), usageRoute },
          testWorkspaceRoots().config,
        );
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(batches.map(batchModels)).toEqual([['hosted']]);
      }),
    );

    it.live(
      'drops optional entries from a batch but keeps the accounted ones',
      () =>
        Effect.gen(function* () {
          stubAccessToken();
          yield* Effect.promise(() =>
            startUsageLog({ batchSize: 100, flushIntervalMs: 60_000 }),
          );

          const { batches, fetchMock } = stubBatchFetch();

          usageLog.log(
            { ...usageEntry('byok'), usageRoute: 'api-key' },
            testWorkspaceRoots().config,
          );
          usageLog.log(
            { ...usageEntry('hosted'), usageRoute: 'chatgpt-subscription' },
            testWorkspaceRoots().config,
          );
          yield* testWorkspaceRoots().config.update(
            TELEMETRY_ENABLED_KEY,
            false,
            'global',
          );

          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));

          expect(fetchMock).toHaveBeenCalledTimes(1);
          expect(batches.map(batchModels)).toEqual([['hosted']]);
        }),
    );

    // The token probe is awaited before the batch is sent, so an opt-out
    // that lands during that await must still take effect.
    it.live(
      'honours an opt-out that lands while the token lookup is in flight',
      () =>
        Effect.gen(function* () {
          const { promise: tokenReleased, resolve: releaseToken } =
            createDeferred();
          installHostAuth(
            fakeSupabaseAuth({
              accessToken: Effect.promise(() => tokenReleased).pipe(
                Effect.map(() => 'token'),
              ),
            }),
          );

          const { batches, fetchMock } = stubBatchFetch();

          usageLog.log(usageEntry('optional'), testWorkspaceRoots().config);

          yield* testWorkspaceRoots().config.update(
            TELEMETRY_ENABLED_KEY,
            false,
            'global',
          );
          releaseToken();

          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
          expect(fetchMock).not.toHaveBeenCalled();
          expect(batches).toEqual([]);
        }),
    );

    // The environment kill switch is what a user has when editing settings is
    // awkward: a CI job, a shared machine, or a one-off `TEXRA_NO_TELEMETRY=1
    // texra run`. It overrides a stored `true` and cannot re-enable logging.
    it.live.each([
      ['TEXRA_NO_TELEMETRY', '1'],
      ['TEXRA_NO_TELEMETRY', 'true'],
      ['DO_NOT_TRACK', '1'],
    ])('sends nothing while %s=%s is set', ([name, value]) =>
      Effect.gen(function* () {
        stubAccessToken();
        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          true,
          'global',
        );
        vi.stubEnv(name, value);

        yield* Effect.promise(() => expectNoOptionalUsageSent());
      }),
    );

    it.live.each(['0', 'false', ''])('ignores TEXRA_NO_TELEMETRY=%p', (value) =>
      Effect.gen(function* () {
        stubAccessToken();
        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          true,
          'global',
        );
        vi.stubEnv('TEXRA_NO_TELEMETRY', value);

        const { batches, fetchMock } = stubBatchFetch();

        usageLog.log(usageEntry('optional'), testWorkspaceRoots().config);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(batches.map(batchModels)).toEqual([['optional']]);
      }),
    );

    // Same carve-out as the setting: plan accounting is derived from these
    // records, so the environment switch must not suppress them either.
    it('still sends plan usage while TEXRA_NO_TELEMETRY is set', async () => {
      stubAccessToken();
      vi.stubEnv('TEXRA_NO_TELEMETRY', '1');

      const { batches, fetchMock } = stubBatchFetch();

      usageLog.log(
        { ...usageEntry('hosted'), usageRoute: 'chatgpt-subscription' },
        testWorkspaceRoots().config,
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(batches.map(batchModels)).toEqual([['hosted']]);
    });

    // JsonConfigProvider returns raw JSON from a hand-edited .texra/config.json,
    // so a mistyped string must not read as truthy and re-enable logging.
    it.live.each(['false', '0', 0, null])(
      'treats the non-boolean value %p as opted out',
      (value) =>
        Effect.gen(function* () {
          stubAccessToken();
          yield* testWorkspaceRoots().config.update(
            TELEMETRY_ENABLED_KEY,
            value,
            'global',
          );

          const { batches, fetchMock } = stubBatchFetch();

          usageLog.log(usageEntry('optional'), testWorkspaceRoots().config);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));

          expect(fetchMock).not.toHaveBeenCalled();
          expect(batches).toEqual([]);
        }),
    );

    it.live(
      'fails closed for a malformed workspace value despite a valid global opt-in',
      () =>
        Effect.gen(function* () {
          stubAccessToken();
          yield* testWorkspaceRoots().config.update(
            TELEMETRY_ENABLED_KEY,
            true,
            'global',
          );
          yield* testWorkspaceRoots().config.update(
            TELEMETRY_ENABLED_KEY,
            'false',
            'workspace',
          );

          const { batches, fetchMock } = stubBatchFetch();

          usageLog.log(usageEntry('optional'), testWorkspaceRoots().config);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));

          expect(fetchMock).not.toHaveBeenCalled();
          expect(batches).toEqual([]);
        }),
    );
  });
});

it.live('does not carry unsent usage into a new logger lifetime', () =>
  Effect.gen(function* () {
    const { batches } = stubBatchFetch();
    const record = (model: string, accessToken: string | null) =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            usageLogLayer({
              version: undefined,
              editorType: undefined,
              config: { batchSize: 100 },
            }),
          );
          Context.get(context, UsageLog).log(
            usageEntry(model),
            testWorkspaceRoots().config,
          );
        }),
      ).pipe(
        Effect.provideService(
          SupabaseAuth,
          fakeSupabaseAuth({ accessToken: Effect.succeed(accessToken) }),
        ),
        Effect.provide(testHttpClientLayer),
      );

    yield* record('unsent', null);
    yield* record('fresh', 'token');
    expect(batches.map(batchModels)).toEqual([['fresh']]);
  }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals()))),
);
