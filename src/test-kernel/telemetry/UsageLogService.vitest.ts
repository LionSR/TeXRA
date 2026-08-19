import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

import { SupabaseClient } from '@auth/SupabaseClient';
import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import { AgentCategory, TELEMETRY_ENABLED_KEY } from '@shared/schemas';
import {
  USAGE_LOG_FLUSH_OUTCOME,
  UsageLogService,
} from '@telemetry/UsageLogService';
import { createDeferred } from '@test/support/asyncTestUtils';
import {
  createFakePlatform,
  FakeScopedConfigProvider,
} from '@test/support/FakePlatform';
import { jsonResponse } from '@test/support/fetchTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

function usageEntry(model: string) {
  return {
    model,
    provider: 'openai' as const,
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
  vi.spyOn(SupabaseClient, 'getAccessToken').mockResolvedValue('token');
}

// ky passes a Request object; read each batch body from it. `beforeRespond`
// lets a test stall or fail a specific call before the success response.
function stubFetch(
  batches: unknown[],
  beforeRespond: (
    callCount: number,
  ) => void | Response | Promise<void | Response> = () => {},
): Mock {
  const fetchMock = vi.fn(async (request: Request) => {
    batches.push(await request.json());
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
  beforeEach(() => {
    UsageLogService.initialize({
      batchSize: 100,
      flushIntervalMs: 60_000,
      enabled: true,
    });
  });

  afterEach(async () => {
    await UsageLogService.dispose();
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

    UsageLogService.log(usageEntry('first'));
    const firstFlush = UsageLogService.flush();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    UsageLogService.log(usageEntry('second'));
    const secondFlush = UsageLogService.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirstFetch();
    await expect(Promise.all([firstFlush, secondFlush])).resolves.toEqual([
      USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
      USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches.map(batchModels)).toEqual([['first'], ['second']]);
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

    UsageLogService.log(usageEntry('first'));
    const firstFlush = UsageLogService.flush();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    UsageLogService.log(usageEntry('second'));
    const secondFlush = UsageLogService.flush();
    const disposal = UsageLogService.dispose();

    releaseFirstFetch();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseSecondFetch();
    await expect(Promise.all([firstFlush, secondFlush])).resolves.toEqual([
      USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
      USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
    ]);
    await expect(disposal).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches.map(batchModels)).toEqual([['first'], ['second']]);
  });

  it('warns after five seconds without bounding disposal', async () => {
    stubAccessToken();
    const warn = vi.spyOn(logger, 'warn');

    const { promise: fetchReleased, resolve: releaseFetch } = createDeferred();
    const { batches, fetchMock } = stubBatchFetch(async () => {
      await fetchReleased;
    });

    UsageLogService.log(usageEntry('slow'));
    const flush = UsageLogService.flush();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const disposal = UsageLogService.dispose();
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(warn).not.toHaveBeenCalledWith(
      'UsageLogService',
      'Dispose timeout waiting for in-flight flush',
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(warn).toHaveBeenCalledWith(
      'UsageLogService',
      'Dispose timeout waiting for in-flight flush',
    );
    expect(disposed).toBe(false);

    releaseFetch();
    await expect(flush).resolves.toBe(USAGE_LOG_FLUSH_OUTCOME.ACCEPTED);
    await expect(disposal).resolves.toBeUndefined();
    expect(batches.map(batchModels)).toEqual([['slow']]);
    vi.useRealTimers();
  });

  it('keeps queued entries when setup fails before dequeue', async () => {
    vi.spyOn(SupabaseClient, 'getAccessToken')
      .mockRejectedValueOnce(new Error('auth unavailable'))
      .mockResolvedValue('token');

    const { batches, fetchMock } = stubBatchFetch();

    UsageLogService.log(usageEntry('first'));
    await expect(UsageLogService.flush()).resolves.toBe(
      USAGE_LOG_FLUSH_OUTCOME.PENDING,
    );

    expect(fetchMock).not.toHaveBeenCalled();

    await expect(UsageLogService.flush()).resolves.toBe(
      USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
    );

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

    UsageLogService.log(usageEntry('first'));
    await expect(UsageLogService.flush()).resolves.toBe(
      USAGE_LOG_FLUSH_OUTCOME.PENDING,
    );
    await expect(UsageLogService.flush()).resolves.toBe(
      USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
    );

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

    UsageLogService.log(usageEntry('invalid'));
    const flush = UsageLogService.flush();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    UsageLogService.log(usageEntry('valid'));
    releaseRejection();

    await expect(flush).resolves.toBe(USAGE_LOG_FLUSH_OUTCOME.REJECTED);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches.map(batchModels)).toEqual([['invalid'], ['valid']]);
    expect(batchId(batches[1])).not.toBe(batchId(batches[0]));

    await expect(UsageLogService.flush()).resolves.toBe(
      USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
    );
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

    UsageLogService.log(usageEntry('first'));
    await expect(UsageLogService.flush()).resolves.toBe(
      USAGE_LOG_FLUSH_OUTCOME.PENDING,
    );

    UsageLogService.log(usageEntry('second'));
    await expect(UsageLogService.flush()).resolves.toBe(
      USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
    );

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
    setupPlatform(() =>
      createFakePlatform({}, { config: new FakeScopedConfigProvider() }),
    );

    // Shared tail of every opt-out case: an optional entry must vanish without
    // a single fetch, and the flush still reports ACCEPTED — the entry is
    // gone, not kept for retry (that would be PENDING).
    async function expectOptedOutFlush(): Promise<void> {
      const { batches, fetchMock } = stubBatchFetch();

      UsageLogService.log(usageEntry('optional'));
      await expect(UsageLogService.flush()).resolves.toBe(
        USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(batches).toEqual([]);
    }

    it('sends nothing while the setting is off', async () => {
      stubAccessToken();
      await platform().config.update(TELEMETRY_ENABLED_KEY, false, 'global');

      await expectOptedOutFlush();
    });

    it('honours a workspace-scoped telemetry opt-out', async () => {
      stubAccessToken();
      await platform().config.update(TELEMETRY_ENABLED_KEY, false, 'workspace');

      await expectOptedOutFlush();
    });

    it('does not let a project opt in over a user-wide opt-out', async () => {
      stubAccessToken();
      await platform().config.update(TELEMETRY_ENABLED_KEY, false, 'global');
      await platform().config.update(TELEMETRY_ENABLED_KEY, true, 'workspace');

      await expectOptedOutFlush();
    });

    // The setting is read live, so turning it off has to drop rounds already
    // queued under the old value rather than letting the next flush ship them.
    it('discards entries queued before the setting was turned off', async () => {
      stubAccessToken();

      const { batches, fetchMock } = stubBatchFetch();

      UsageLogService.log(usageEntry('before-opt-out'));
      await platform().config.update(TELEMETRY_ENABLED_KEY, false, 'global');

      // ACCEPTED, not PENDING: the entry is gone, and PENDING means "kept for a
      // later retry" everywhere else in this service.
      await expect(UsageLogService.flush()).resolves.toBe(
        USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(batches).toEqual([]);
    });

    it('resumes sending once the setting is turned back on', async () => {
      stubAccessToken();
      await platform().config.update(TELEMETRY_ENABLED_KEY, false, 'global');

      const { batches, fetchMock } = stubBatchFetch();

      UsageLogService.log(usageEntry('dropped'));
      await UsageLogService.flush();
      expect(fetchMock).not.toHaveBeenCalled();

      await platform().config.update(TELEMETRY_ENABLED_KEY, true, 'global');
      UsageLogService.log(usageEntry('sent'));
      await expect(UsageLogService.flush()).resolves.toBe(
        USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(batches.map(batchModels)).toEqual([['sent']]);
    });

    // Plan accounting is derived from the aggregate that these records
    // populate, so an opt-out that suppressed them would let plan-covered
    // calls run on against a stale total. Only `api-key` rounds are optional.
    it.each([
      'chatgpt-subscription',
      'xai-subscription',
      'kimi-code-subscription',
      'glm-coding-plan-subscription',
    ] as const)(
      'still sends %s usage while the setting is off',
      async (usageRoute) => {
        stubAccessToken();
        await platform().config.update(TELEMETRY_ENABLED_KEY, false, 'global');

        const { batches, fetchMock } = stubBatchFetch();

        UsageLogService.log({ ...usageEntry('hosted'), usageRoute });
        await expect(UsageLogService.flush()).resolves.toBe(
          USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(batches.map(batchModels)).toEqual([['hosted']]);
      },
    );

    it('drops optional entries from a batch but keeps the accounted ones', async () => {
      stubAccessToken();

      const { batches, fetchMock } = stubBatchFetch();

      UsageLogService.log({ ...usageEntry('byok'), usageRoute: 'api-key' });
      UsageLogService.log({
        ...usageEntry('hosted'),
        usageRoute: 'chatgpt-subscription',
      });
      await platform().config.update(TELEMETRY_ENABLED_KEY, false, 'global');

      await expect(UsageLogService.flush()).resolves.toBe(
        USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(batches.map(batchModels)).toEqual([['hosted']]);
    });

    // getAccessToken() is awaited before the batch is sent, so an opt-out
    // that lands during that await must still take effect.
    it('honours an opt-out that lands while the token lookup is in flight', async () => {
      const { promise: tokenReleased, resolve: releaseToken } =
        createDeferred();
      vi.spyOn(SupabaseClient, 'getAccessToken').mockImplementation(
        async () => {
          await tokenReleased;
          return 'token';
        },
      );

      const { batches, fetchMock } = stubBatchFetch();

      UsageLogService.log(usageEntry('optional'));
      const flush = UsageLogService.flush();

      await platform().config.update(TELEMETRY_ENABLED_KEY, false, 'global');
      releaseToken();

      await expect(flush).resolves.toBe(USAGE_LOG_FLUSH_OUTCOME.ACCEPTED);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(batches).toEqual([]);
    });

    // The environment kill switch is what a user has when editing settings is
    // awkward: a CI job, a shared machine, or a one-off `TEXRA_NO_TELEMETRY=1
    // texra run`. It overrides a stored `true` and cannot re-enable logging.
    it.each([
      ['TEXRA_NO_TELEMETRY', '1'],
      ['TEXRA_NO_TELEMETRY', 'true'],
      ['DO_NOT_TRACK', '1'],
    ])('sends nothing while %s=%s is set', async (name, value) => {
      stubAccessToken();
      await platform().config.update(TELEMETRY_ENABLED_KEY, true, 'global');
      vi.stubEnv(name, value);

      await expectOptedOutFlush();
    });

    it.each(['0', 'false', ''])(
      'ignores TEXRA_NO_TELEMETRY=%p',
      async (value) => {
        stubAccessToken();
        await platform().config.update(TELEMETRY_ENABLED_KEY, true, 'global');
        vi.stubEnv('TEXRA_NO_TELEMETRY', value);

        const { batches, fetchMock } = stubBatchFetch();

        UsageLogService.log(usageEntry('optional'));
        await expect(UsageLogService.flush()).resolves.toBe(
          USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(batches.map(batchModels)).toEqual([['optional']]);
      },
    );

    // Same carve-out as the setting: plan accounting is derived from these
    // records, so the environment switch must not suppress them either.
    it('still sends plan usage while TEXRA_NO_TELEMETRY is set', async () => {
      stubAccessToken();
      vi.stubEnv('TEXRA_NO_TELEMETRY', '1');

      const { batches, fetchMock } = stubBatchFetch();

      UsageLogService.log({
        ...usageEntry('hosted'),
        usageRoute: 'chatgpt-subscription',
      });
      await expect(UsageLogService.flush()).resolves.toBe(
        USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(batches.map(batchModels)).toEqual([['hosted']]);
    });

    // JsonConfigProvider returns raw JSON from a hand-edited .texra/config.json,
    // so a mistyped string must not read as truthy and re-enable logging.
    it.each(['false', '0', 0, null])(
      'treats the non-boolean value %p as opted out',
      async (value) => {
        stubAccessToken();
        await platform().config.update(TELEMETRY_ENABLED_KEY, value, 'global');

        const { batches, fetchMock } = stubBatchFetch();

        UsageLogService.log(usageEntry('optional'));
        await UsageLogService.flush();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(batches).toEqual([]);
      },
    );

    it('fails closed for a malformed workspace value despite a valid global opt-in', async () => {
      stubAccessToken();
      await platform().config.update(TELEMETRY_ENABLED_KEY, true, 'global');
      await platform().config.update(
        TELEMETRY_ENABLED_KEY,
        'false',
        'workspace',
      );

      const { batches, fetchMock } = stubBatchFetch();

      UsageLogService.log(usageEntry('optional'));
      await UsageLogService.flush();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(batches).toEqual([]);
    });
  });
});
