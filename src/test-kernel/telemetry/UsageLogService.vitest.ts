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
      true,
      true,
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
    await expect(UsageLogService.flush()).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();

    await expect(UsageLogService.flush()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(batches.map(batchModels)).toEqual([['first']]);
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
    await expect(UsageLogService.flush()).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(UsageLogService.flush()).resolves.toBe(true);

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
      await expect(UsageLogService.flush()).resolves.toBe(false);
      await expect(UsageLogService.flush()).resolves.toBe(true);

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

    await expect(flush).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches.map(batchModels)).toEqual([['invalid'], ['valid']]);
    expect(batchId(batches[1])).not.toBe(batchId(batches[0]));

    await expect(UsageLogService.flush()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    await expect(UsageLogService.flush()).resolves.toBe(false);

    UsageLogService.log(usageEntry('second'));
    await expect(UsageLogService.flush()).resolves.toBe(true);

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
