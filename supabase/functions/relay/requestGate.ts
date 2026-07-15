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

export const RELAY_SLOT_REFRESH_INTERVAL_MS = 60_000;

export type RelayFailurePhase =
  'pre_headers_timeout' | 'pre_headers_failure' | 'response_body_failure';

const UPSTREAM_REQUEST_ID_HEADERS = [
  'request-id',
  'x-request-id',
  'x-goog-request-id',
] as const;

type RelayRequestBody =
  string | Uint8Array | ReadableStream<Uint8Array> | null | undefined;

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

export function classifyPreHeaderFailure(error: unknown): RelayFailurePhase {
  return error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
    ? 'pre_headers_timeout'
    : 'pre_headers_failure';
}

export function getUpstreamRequestId(headers: Headers): string | null {
  for (const header of UPSTREAM_REQUEST_ID_HEADERS) {
    const requestId = headers.get(header)?.trim();
    if (requestId) return requestId;
  }
  return null;
}

export function getRelayRequestBytes(
  body: RelayRequestBody,
  contentLength: string | null,
): number | null {
  if (body == null) return 0;
  if (typeof body === 'string') {
    return new TextEncoder().encode(body).byteLength;
  }
  if (body instanceof Uint8Array) return body.byteLength;

  if (contentLength == null || contentLength.trim() === '') return null;
  const parsedLength = Number(contentLength);
  return Number.isSafeInteger(parsedLength) && parsedLength >= 0
    ? parsedLength
    : null;
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
  refreshIntervalMs = RELAY_SLOT_REFRESH_INTERVAL_MS,
  onUpstreamBodyError?: (error: unknown) => void,
): Promise<ReadableStream<Uint8Array> | null> {
  if (body === null) {
    await release();
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
    void reader
      .cancel(leaseError)
      .then(releaseOnce, releaseOnce)
      .catch((releaseError) => {
        console.error(
          '[RELAY] Failed to release request slot after lease loss:',
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
        stopForLeaseLoss,
      );
    },
    async pull(controller) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (error) {
        try {
          onUpstreamBodyError?.(error);
        } catch {
          console.error('[RELAY] Upstream body failure observer failed');
        }
        await releaseOnce();
        throw error;
      }

      if (leaseError) {
        await releaseOnce();
        throw leaseError;
      }
      if (readResult.done) {
        controller.close();
        await releaseOnce();
        return;
      }
      controller.enqueue(readResult.value);
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
