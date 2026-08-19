import { asFiniteNumber, isJsonRecord } from './json.ts';
import type { RelayRpcClient } from './rpc.ts';

interface RequestLimit {
  ratePerMinute: number;
  concurrent: number;
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

const RELAY_SLOT_REFRESH_INTERVAL_MS = 60_000;

class RelayRequestSlotLostError extends Error {
  constructor() {
    super('relay_request_refresh did not find request slot');
    this.name = 'RelayRequestSlotLostError';
  }
}

function parseGateDecision(data: unknown): GateDecision {
  const record = isJsonRecord(data) ? data : {};
  return {
    allowed: record.allowed === true,
    slotId: typeof record.slotId === 'string' ? record.slotId : undefined,
    reason:
      record.reason === 'rate' || record.reason === 'concurrency'
        ? record.reason
        : undefined,
    rateLimitPerMinute: asFiniteNumber(record.rateLimitPerMinute),
    concurrencyLimit: asFiniteNumber(record.concurrencyLimit),
    requestsThisMinute: asFiniteNumber(record.requestsThisMinute),
    activeRequests: asFiniteNumber(record.activeRequests),
    retryAfterSeconds: asFiniteNumber(record.retryAfterSeconds),
  };
}

function didRefreshSlot(data: unknown): boolean {
  return isJsonRecord(data) && data.refreshed === true;
}

function once(release: () => Promise<void>): () => Promise<void> {
  let released = false;
  return () => {
    if (released) return Promise.resolve();
    released = true;
    return release();
  };
}

/** Release a slot without allowing bookkeeping failure to replace the
 * upstream response or error that the caller is already handling. */
export async function releaseRelaySlotSafely(
  release: (() => Promise<void>) | null | undefined,
): Promise<void> {
  try {
    await release?.();
  } catch {
    console.error('[RELAY] Failed to release request slot');
  }
}

function startStreamLeaseRefresh(
  refresh: (() => Promise<void>) | undefined,
  intervalMs: number,
  onLeaseLost: (error: unknown) => void,
): () => void {
  if (!refresh || intervalMs <= 0) return () => {};

  const timer = setInterval(() => {
    void refresh().catch((error) => {
      console.error('[RELAY] Stream lease refresh failed:', error);
      if (error instanceof RelayRequestSlotLostError) {
        clearInterval(timer);
        onLeaseLost(error);
      }
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

export async function acquireRelayRequestSlot(
  client: RelayRpcClient,
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
      throw new RelayRequestSlotLostError();
    }
  };

  return { allowed: true, release, refresh, decision };
}

export async function releaseWhenStreamCloses(
  body: ReadableStream<Uint8Array> | null,
  release: () => Promise<void>,
  refresh?: () => Promise<void>,
  onUpstreamBodyError?: () => void,
  refreshIntervalMs = RELAY_SLOT_REFRESH_INTERVAL_MS,
): Promise<ReadableStream<Uint8Array> | null> {
  if (body === null) {
    await releaseRelaySlotSafely(release);
    return null;
  }

  let leaseError: Error | null = null;
  let stopRefreshing = () => {};
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  const releaseOnce = once(async () => {
    stopRefreshing();
    await release();
  });
  const reader = body.getReader();
  const stopForLeaseLoss = (error: unknown) => {
    leaseError = error instanceof Error ? error : new Error(String(error));
    stopRefreshing();
    streamController?.error(leaseError);
    void reader.cancel(leaseError).then(
      () => releaseRelaySlotSafely(releaseOnce),
      () => releaseRelaySlotSafely(releaseOnce),
    );
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      stopRefreshing = startStreamLeaseRefresh(
        refresh,
        refreshIntervalMs,
        stopForLeaseLoss,
      );
    },
    async pull(controller) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (error) {
        if (!leaseError) {
          try {
            onUpstreamBodyError?.();
          } catch {
            console.error('[RELAY] Upstream body failure observer failed');
          }
        }
        await releaseRelaySlotSafely(releaseOnce);
        throw leaseError ?? error;
      }

      if (leaseError) {
        await releaseRelaySlotSafely(releaseOnce);
        throw leaseError;
      }
      if (readResult.done) {
        controller.close();
        await releaseRelaySlotSafely(releaseOnce);
        return;
      }
      controller.enqueue(readResult.value);
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await releaseRelaySlotSafely(releaseOnce);
      }
    },
  });
}
