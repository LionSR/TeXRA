import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

import { UsageLogService } from '@telemetry/UsageLogService';
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

function flushResult(pendingEntryCount: number, unacceptedEntryCount = 0) {
  return { pendingEntryCount, unacceptedEntryCount };
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
    return (
      response ??
      new Response(JSON.stringify({ success: true, accepted: 1 }), {
        status: 200,
      })
    );
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
      flushResult(0),
      flushResult(0),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches.map(batchModels)).toEqual([['first'], ['second']]);
  });

  it('keeps queued entries when setup fails before dequeue', async () => {
    vi.spyOn(SupabaseClient, 'getRelayAccessToken')
      .mockRejectedValueOnce(new Error('auth unavailable'))
      .mockResolvedValue('token');

    const batches: unknown[] = [];
    const fetchMock = stubFetch(batches);

    UsageLogService.log(usageEntry('first'));
    await expect(UsageLogService.flush()).resolves.toEqual(flushResult(1));

    expect(fetchMock).not.toHaveBeenCalled();

    await expect(UsageLogService.flush()).resolves.toEqual(flushResult(0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(batches.map(batchModels)).toEqual([['first']]);
  });

  it('reports entries evicted by the queue bound as unaccepted', async () => {
    UsageLogService.initialize({
      batchSize: 2000,
      flushIntervalMs: 60_000,
      enabled: true,
    });
    const tokenSpy = vi
      .spyOn(SupabaseClient, 'getRelayAccessToken')
      .mockResolvedValue(null);
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const batches: unknown[] = [];
    const fetchMock = stubFetch(
      batches,
      () =>
        new Response(JSON.stringify({ success: true, accepted: 1000 }), {
          status: 200,
        }),
    );

    for (let index = 0; index < 1001; index += 1) {
      UsageLogService.log(usageEntry(`entry-${index}`));
    }

    await expect(UsageLogService.flush()).resolves.toEqual(
      flushResult(1000, 1),
    );

    tokenSpy.mockResolvedValue('token');
    await expect(UsageLogService.flush()).resolves.toEqual(flushResult(0, 1));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('requeues entries when send fails after dequeue', async () => {
    vi.spyOn(SupabaseClient, 'getRelayAccessToken').mockResolvedValue('token');

    const batches: unknown[] = [];
    const fetchMock = stubFetch(batches, (callCount) => {
      if (callCount === 1) {
        throw new Error('network unavailable');
      }
    });

    UsageLogService.log(usageEntry('first'));
    await expect(UsageLogService.flush()).resolves.toEqual(flushResult(1));

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(UsageLogService.flush()).resolves.toEqual(flushResult(0));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches.map(batchModels)).toEqual([['first'], ['first']]);
    expect(batchId(batches[1])).toBe(batchId(batches[0]));
  });

  it.each([
    ['malformed', { success: true }],
    ['rejected', { success: false, accepted: 0, error: 'invalid batch' }],
    ['partial', { success: true, accepted: 0 }],
  ])(
    'requeues entries after a %s acknowledgement',
    async (_case, acknowledgement) => {
      vi.spyOn(SupabaseClient, 'getRelayAccessToken').mockResolvedValue(
        'token',
      );

      const batches: unknown[] = [];
      const fetchMock = stubFetch(batches, (callCount) => {
        if (callCount === 1) {
          return new Response(JSON.stringify(acknowledgement), { status: 200 });
        }
      });

      UsageLogService.log(usageEntry('first'));
      await expect(UsageLogService.flush()).resolves.toEqual(flushResult(1));
      await expect(UsageLogService.flush()).resolves.toEqual(flushResult(0));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(batches.map(batchModels)).toEqual([['first'], ['first']]);
      expect(batchId(batches[1])).toBe(batchId(batches[0]));
    },
  );

  it('quarantines a permanent rejection and continues with later entries', async () => {
    vi.spyOn(SupabaseClient, 'getRelayAccessToken').mockResolvedValue('token');

    let releaseRejection: (() => void) | undefined;
    const rejectionReleased = new Promise<void>((resolve) => {
      releaseRejection = resolve;
    });
    const batches: unknown[] = [];
    const fetchMock = stubFetch(batches, async (callCount) => {
      if (callCount !== 1) return;
      await rejectionReleased;
      return new Response(
        JSON.stringify({
          success: false,
          accepted: 0,
          error: 'invalid batch',
          retryable: false,
        }),
        { status: 422 },
      );
    });

    UsageLogService.log(usageEntry('invalid'));
    const flush = UsageLogService.flush();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    UsageLogService.log(usageEntry('valid'));
    releaseRejection?.();

    await expect(flush).resolves.toEqual(flushResult(0, 1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches.map(batchModels)).toEqual([['invalid'], ['valid']]);
    expect(batchId(batches[1])).not.toBe(batchId(batches[0]));

    await expect(UsageLogService.flush()).resolves.toEqual(flushResult(0, 1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds the permanent-rejection quarantine by evicting oldest batches', async () => {
    UsageLogService.initialize({
      batchSize: 101,
      flushIntervalMs: 60_000,
      enabled: true,
    });
    vi.spyOn(SupabaseClient, 'getRelayAccessToken').mockResolvedValue('token');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const batches: unknown[] = [];
    const fetchMock = stubFetch(
      batches,
      () =>
        new Response(
          JSON.stringify({
            success: false,
            accepted: 0,
            error: 'invalid batch',
            retryable: false,
          }),
          { status: 422 },
        ),
    );

    for (let batchIndex = 0; batchIndex < 11; batchIndex += 1) {
      for (let entryIndex = 0; entryIndex < 100; entryIndex += 1) {
        UsageLogService.log(usageEntry(`${batchIndex}-${entryIndex}`));
      }
      await expect(UsageLogService.flush()).resolves.toEqual(
        flushResult(0, (batchIndex + 1) * 100),
      );
    }

    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(errorSpy).toHaveBeenCalledWith(
      'UsageLogService',
      'Usage rejection quarantine reached its 1000-entry bound; evicted 100 oldest entries',
    );

    const quarantinedBatches = Reflect.get(
      UsageLogService,
      'quarantinedBatches',
    ) as Array<{ batch: unknown }>;
    expect(quarantinedBatches).toHaveLength(10);
    expect(quarantinedBatches.map(({ batch }) => batchId(batch))).toEqual(
      batches.slice(1).map(batchId),
    );
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
    await expect(UsageLogService.flush()).resolves.toEqual(flushResult(1));

    UsageLogService.log(usageEntry('second'));
    await expect(UsageLogService.flush()).resolves.toEqual(flushResult(0));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(batches.map(batchModels)).toEqual([
      ['first'],
      ['first'],
      ['second'],
    ]);
    expect(batchId(batches[1])).toBe(batchId(batches[0]));
    expect(batchId(batches[2])).not.toBe(batchId(batches[0]));
  });

  it('preserves a retry batch across dispose and reinitialization', async () => {
    const tokenSpy = vi
      .spyOn(SupabaseClient, 'getRelayAccessToken')
      .mockResolvedValue('token');
    const batches: unknown[] = [];
    const fetchMock = stubFetch(batches, (callCount) => {
      if (callCount === 1) throw new Error('network unavailable');
    });

    UsageLogService.log(usageEntry('first'));
    await expect(UsageLogService.flush()).resolves.toEqual(flushResult(1));
    tokenSpy.mockResolvedValue(null);

    await UsageLogService.dispose();
    UsageLogService.initialize({
      batchSize: 100,
      flushIntervalMs: 60_000,
      enabled: true,
    });
    tokenSpy.mockResolvedValue('token');

    await expect(UsageLogService.flush()).resolves.toEqual(flushResult(0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batchId(batches[1])).toBe(batchId(batches[0]));
  });
});
