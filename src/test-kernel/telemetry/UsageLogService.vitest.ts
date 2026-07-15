import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

import {
  USAGE_LOG_FLUSH_OUTCOME,
  UsageLogService,
} from '@telemetry/UsageLogService';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { SupabaseClient } from '@auth/SupabaseClient';
import * as logger from '@logger/logUtils';

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
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
    vi.restoreAllMocks();
  });

  it('drains entries queued while another flush is in flight', async () => {
    vi.spyOn(SupabaseClient, 'getRelayAccessToken').mockResolvedValue('token');

    let releaseFirstFetch: (() => void) | undefined;
    const firstFetchReleased = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const batches: unknown[] = [];
    const fetchMock = stubFetch(batches, async (callCount) => {
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

    releaseFirstFetch?.();
    await expect(Promise.all([firstFlush, secondFlush])).resolves.toEqual([
      USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
      USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches.map(batchModels)).toEqual([['first'], ['second']]);
  });

  it('waits for successive active batches during disposal', async () => {
    vi.spyOn(SupabaseClient, 'getRelayAccessToken').mockResolvedValue('token');

    let releaseFirstFetch: (() => void) | undefined;
    let releaseSecondFetch: (() => void) | undefined;
    const firstFetchReleased = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const secondFetchReleased = new Promise<void>((resolve) => {
      releaseSecondFetch = resolve;
    });
    const batches: unknown[] = [];
    const fetchMock = stubFetch(batches, async (callCount) => {
      if (callCount === 1) await firstFetchReleased;
      if (callCount === 2) await secondFetchReleased;
    });

    UsageLogService.log(usageEntry('first'));
    const firstFlush = UsageLogService.flush();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    UsageLogService.log(usageEntry('second'));
    const secondFlush = UsageLogService.flush();
    const disposal = UsageLogService.dispose();

    releaseFirstFetch?.();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseSecondFetch?.();
    await expect(Promise.all([firstFlush, secondFlush])).resolves.toEqual([
      USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
      USAGE_LOG_FLUSH_OUTCOME.ACCEPTED,
    ]);
    await expect(disposal).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches.map(batchModels)).toEqual([['first'], ['second']]);
  });

  it('warns after five seconds without bounding disposal', async () => {
    vi.spyOn(SupabaseClient, 'getRelayAccessToken').mockResolvedValue('token');
    const warn = vi.spyOn(logger, 'warn');

    let releaseFetch: (() => void) | undefined;
    const fetchReleased = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const batches: unknown[] = [];
    const fetchMock = stubFetch(batches, async () => {
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

    releaseFetch?.();
    await expect(flush).resolves.toBe(USAGE_LOG_FLUSH_OUTCOME.ACCEPTED);
    await expect(disposal).resolves.toBeUndefined();
    expect(batches.map(batchModels)).toEqual([['slow']]);
    vi.useRealTimers();
  });

  it('keeps queued entries when setup fails before dequeue', async () => {
    vi.spyOn(SupabaseClient, 'getRelayAccessToken')
      .mockRejectedValueOnce(new Error('auth unavailable'))
      .mockResolvedValue('token');

    const batches: unknown[] = [];
    const fetchMock = stubFetch(batches);

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
    vi.spyOn(SupabaseClient, 'getRelayAccessToken').mockResolvedValue('token');

    const batches: unknown[] = [];
    const fetchMock = stubFetch(batches, (callCount) => {
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
    vi.spyOn(SupabaseClient, 'getRelayAccessToken').mockResolvedValue('token');

    let releaseRejection: (() => void) | undefined;
    const rejectionReleased = new Promise<void>((resolve) => {
      releaseRejection = resolve;
    });
    const batches: unknown[] = [];
    const fetchMock = stubFetch(batches, async (callCount) => {
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
    releaseRejection?.();

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
    vi.spyOn(SupabaseClient, 'getRelayAccessToken').mockResolvedValue('token');

    const batches: unknown[] = [];
    const fetchMock = stubFetch(batches, (callCount) => {
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
});
