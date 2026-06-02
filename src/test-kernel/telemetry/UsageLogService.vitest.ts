import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UsageLogService } from '@telemetry/UsageLogService';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { SupabaseClient } from '@auth/SupabaseClient';

const usageEntry = (model: string) => ({
  model,
  provider: 'openai' as const,
  agentName: 'agent',
  agentCategory: AgentCategory.ToolUse,
  inputTokens: 1,
  outputTokens: 1,
  cost: 0.001,
});

function batchModels(batch: unknown): string[] {
  const entries = (batch as { entries: Array<{ model: string }> }).entries;
  return entries.map((entry) => entry.model);
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
    vi.spyOn(SupabaseClient, 'getAccessToken').mockResolvedValue('token');

    let releaseFirstFetch: (() => void) | undefined;
    const firstFetchReleased = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const batches: unknown[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      batches.push(JSON.parse(String(init?.body)));
      if (fetchMock.mock.calls.length === 1) {
        await firstFetchReleased;
      }
      return new Response(JSON.stringify({ success: true, accepted: 1 }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    UsageLogService.log(usageEntry('first'));
    const firstFlush = UsageLogService.flush();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    UsageLogService.log(usageEntry('second'));
    const secondFlush = UsageLogService.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirstFetch?.();
    await Promise.all([firstFlush, secondFlush]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches.map(batchModels)).toEqual([['first'], ['second']]);
  });

  it('keeps queued entries when setup fails before dequeue', async () => {
    vi.spyOn(SupabaseClient, 'getAccessToken')
      .mockRejectedValueOnce(new Error('auth unavailable'))
      .mockResolvedValue('token');

    const batches: unknown[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      batches.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ success: true, accepted: 1 }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    UsageLogService.log(usageEntry('first'));
    await UsageLogService.flush();

    expect(fetchMock).not.toHaveBeenCalled();

    await UsageLogService.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(batches.map(batchModels)).toEqual([['first']]);
  });
});
