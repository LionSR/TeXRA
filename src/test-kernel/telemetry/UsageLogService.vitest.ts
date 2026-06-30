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

// ky passes a Request object; read each batch body from it. `beforeRespond`
// lets a test stall or fail a specific call before the success response.
function stubFetch(
  batches: unknown[],
  beforeRespond: (callCount: number) => void | Promise<void> = () => {},
): Mock {
  const fetchMock = vi.fn(async (request: Request) => {
    batches.push(await request.json());
    await beforeRespond(fetchMock.mock.calls.length);
    return new Response(JSON.stringify({ success: true, accepted: 1 }), {
      status: 200,
    });
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
  });
});
