interface RpcError {
  message?: string;
}

interface RequestLimit {
  ratePerMinute: number;
  concurrent: number;
}

interface RpcClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: RpcError | null }>;
}

interface GateDecision {
  allowed: boolean;
  slotId?: string;
  reason?: 'rate' | 'concurrency';
  rateLimitPerMinute?: number;
  concurrencyLimit?: number;
  requestsThisMinute?: number;
  activeRequests?: number;
  retryAfterSeconds?: number;
}

export type RelayRequestSlot =
  | {
      allowed: true;
      release: () => Promise<void>;
      refresh: () => Promise<void>;
      decision: GateDecision;
    }
  | {
      allowed: false;
      release: null;
      decision: GateDecision;
    };

export const RELAY_SLOT_REFRESH_INTERVAL_MS = 60_000;
export const RELAY_SLOT_REFRESH_MAX_FAILURES = 3;

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function parseGateDecision(data: unknown): GateDecision {
  const record =
    typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>)
      : {};
  return {
    allowed: record.allowed === true,
    slotId: typeof record.slotId === 'string' ? record.slotId : undefined,
    reason:
      record.reason === 'rate' || record.reason === 'concurrency'
        ? record.reason
        : undefined,
    rateLimitPerMinute: asNumber(record.rateLimitPerMinute),
    concurrencyLimit: asNumber(record.concurrencyLimit),
    requestsThisMinute: asNumber(record.requestsThisMinute),
    activeRequests: asNumber(record.activeRequests),
    retryAfterSeconds: asNumber(record.retryAfterSeconds),
  };
}

function didRefreshSlot(data: unknown): boolean {
  const record =
    typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>)
      : {};
  return record.refreshed === true;
}

function once(release: () => Promise<void>): () => Promise<void> {
  let released = false;
  return () => {
    if (released) return Promise.resolve();
    released = true;
    return release();
  };
}

function startStreamLeaseRefresh(
  refresh: (() => Promise<void>) | undefined,
  intervalMs: number,
  onFailure: (error: unknown) => void,
): () => void {
  if (!refresh || intervalMs <= 0) return () => {};

  let consecutiveFailures = 0;
  const timer = setInterval(() => {
    void refresh()
      .then(() => {
        consecutiveFailures = 0;
      })
      .catch((error) => {
        consecutiveFailures += 1;
        console.error('[RELAY] Stream lease refresh failed:', error);
        if (consecutiveFailures >= RELAY_SLOT_REFRESH_MAX_FAILURES) {
          clearInterval(timer);
          onFailure(error);
        }
      });
  }, intervalMs);
  return () => clearInterval(timer);
}

export async function acquireRelayRequestSlot(
  client: RpcClient,
  userId: string,
  limits: RequestLimit,
): Promise<RelayRequestSlot> {
  const slotId = globalThis.crypto.randomUUID();
  const now = new Date();
  const windowStart = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
    ),
  ).toISOString();

  const { data, error } = await client.rpc('relay_request_gate', {
    p_user_id: userId,
    p_slot_id: slotId,
    p_window_start: windowStart,
    p_rate_limit: limits.ratePerMinute,
    p_concurrency_limit: limits.concurrent,
  });
  if (error) {
    throw new Error(error.message ?? 'relay_request_gate failed');
  }

  const decision = parseGateDecision(data);
  if (!decision.allowed) {
    return { allowed: false, release: null, decision };
  }

  const release = once(async () => {
    const releaseResult = await client.rpc('relay_request_release', {
      p_user_id: userId,
      p_slot_id: slotId,
    });
    if (releaseResult.error) {
      console.error(
        '[RELAY] Failed to release request slot:',
        releaseResult.error.message,
      );
    }
  });
  const refresh = async () => {
    const refreshResult = await client.rpc('relay_request_refresh', {
      p_user_id: userId,
      p_slot_id: slotId,
    });
    if (refreshResult.error) {
      throw new Error(
        refreshResult.error.message ?? 'relay_request_refresh failed',
      );
    }
    if (!didRefreshSlot(refreshResult.data)) {
      throw new Error('relay_request_refresh did not find request slot');
    }
  };

  return { allowed: true, release, refresh, decision };
}

export async function releaseWhenStreamCloses(
  body: ReadableStream<Uint8Array> | null,
  release: () => Promise<void>,
  refresh?: () => Promise<void>,
  refreshIntervalMs = RELAY_SLOT_REFRESH_INTERVAL_MS,
): Promise<ReadableStream<Uint8Array> | null> {
  if (body === null) {
    await release();
    return null;
  }

  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  let stopRefreshing = () => {};
  const releaseOnce = once(async () => {
    stopRefreshing();
    await release();
  });
  const reader = body.getReader();
  const failStreamForLeaseError = (error: unknown) => {
    const streamError =
      error instanceof Error ? error : new Error(String(error));
    streamController?.error(streamError);
    void reader
      .cancel(streamError)
      .then(releaseOnce, releaseOnce)
      .catch((releaseError) => {
        console.error(
          '[RELAY] Failed to release request slot after refresh failure:',
          releaseError,
        );
      });
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      stopRefreshing = startStreamLeaseRefresh(
        refresh,
        refreshIntervalMs,
        failStreamForLeaseError,
      );
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await releaseOnce();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        await releaseOnce();
        throw error;
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await releaseOnce();
      }
    },
  });
}
