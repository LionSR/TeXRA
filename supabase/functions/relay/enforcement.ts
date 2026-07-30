// Local imports
import { getSpendingLimit } from './models.ts';
import type { RelayRpcClient, RelayRpcError } from './rpc.ts';

/** Availability of the privileged client required by relay enforcement. */
export type RelayEnforcementClientResult<T> =
  | {
      ok: true;
      client: T;
    }
  | {
      ok: false;
      reason: 'service_role_unavailable';
    };

/** Verified spending, or an unavailable state that cannot be treated as allowed. */
export type SpendingCheckResult =
  | {
      status: 'verified';
      allowed: boolean;
      currentSpend: number;
      limit: number;
      remaining: number;
    }
  | {
      status: 'unavailable';
      reason: 'spending_rpc_failed' | 'invalid_spending_response';
      limit: number;
    };

const POSTGRES_NUMERIC_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Require the privileged client used by every key-bearing relay request. */
export function requireRelayEnforcementClient<T>(
  client: T | null,
): RelayEnforcementClientResult<T> {
  return client === null
    ? { ok: false, reason: 'service_role_unavailable' }
    : { ok: true, client };
}

function getCurrentMonthStartUTC(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
}

function parseCurrentSpend(data: unknown): number | undefined {
  if (typeof data === 'number') {
    return Number.isFinite(data) && data >= 0 ? data : undefined;
  }
  if (typeof data !== 'string' || !POSTGRES_NUMERIC_PATTERN.test(data)) {
    return undefined;
  }

  const parsed = Number(data);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return 'unknown error';
}

/**
 * Verify the user's monthly relay spending against the database aggregate.
 * Unavailable or malformed results have no `allowed` value, so callers must
 * handle them separately from a verified zero-dollar spend.
 *
 * This is a soft limit rather than a transaction boundary: usage is logged
 * asynchronously, so concurrent requests can pass before their costs appear
 * in the aggregate. The aggregation is defined by migrations
 * `20260517100000_usage_logs_upsert_rpc.sql` and
 * `20260517100100_usage_logs_aggregate_per_stream.sql`.
 */
export async function checkSpendingLimit(
  adminClient: RelayRpcClient,
  userId: string,
  tier: string,
): Promise<SpendingCheckResult> {
  const limit = getSpendingLimit(tier);

  let result: { data: unknown; error: RelayRpcError | null };
  try {
    result = await adminClient.rpc('get_user_monthly_relay_spend', {
      p_user_id: userId,
      p_month_start: getCurrentMonthStartUTC(),
    });
  } catch (error) {
    console.error('[RELAY] Monthly spending RPC threw:', errorMessage(error));
    return { status: 'unavailable', reason: 'spending_rpc_failed', limit };
  }

  if (result.error) {
    console.error(
      '[RELAY] Monthly spending RPC failed:',
      result.error.message ?? 'unknown error',
    );
    return { status: 'unavailable', reason: 'spending_rpc_failed', limit };
  }

  const currentSpend = parseCurrentSpend(result.data);
  if (currentSpend === undefined) {
    let responseType: string = typeof result.data;
    if (Array.isArray(result.data)) responseType = 'array';
    else if (result.data === null) responseType = 'null';
    console.error(
      `[RELAY] Monthly spending RPC returned invalid ${responseType} data`,
    );
    return {
      status: 'unavailable',
      reason: 'invalid_spending_response',
      limit,
    };
  }

  return {
    status: 'verified',
    allowed: currentSpend < limit,
    currentSpend,
    limit,
    remaining: Math.max(0, limit - currentSpend),
  };
}
