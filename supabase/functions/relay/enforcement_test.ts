// Standard library imports
import { strict as assert } from 'node:assert';

// Local imports
import {
  checkSpendingLimit,
  requireRelayEnforcementClient,
  type SpendingCheckResult,
} from './enforcement.ts';
import type { RelayRpcClient } from './rpc.ts';

function rpcClient(
  data: unknown,
  error: { message?: string } | null = null,
): RelayRpcClient {
  return {
    rpc: () => Promise.resolve({ data, error }),
  };
}

function assertUnavailable(
  result: SpendingCheckResult,
  reason: 'spending_rpc_failed' | 'invalid_spending_response',
): void {
  assert.equal(result.status, 'unavailable');
  if (result.status !== 'unavailable') return;

  assert.equal(result.reason, reason);
  assert.equal('allowed' in result, false);
  assert.equal('currentSpend' in result, false);
  assert.equal('remaining' in result, false);
}

Deno.test('requires an administrative client for relay enforcement', () => {
  assert.deepEqual(requireRelayEnforcementClient(null), {
    ok: false,
    reason: 'service_role_unavailable',
  });

  const client = rpcClient(0);
  assert.deepEqual(requireRelayEnforcementClient(client), {
    ok: true,
    client,
  });
});

Deno.test('accepts verified numeric spending responses', async () => {
  for (const data of [12.5, '12.50']) {
    const result = await checkSpendingLimit(rpcClient(data), 'user-id', 'Max');

    assert.deepEqual(result, {
      status: 'verified',
      allowed: true,
      currentSpend: 12.5,
      limit: 50,
      remaining: 37.5,
    });
  }
});

Deno.test('denies spending at the verified tier limit', async () => {
  const result = await checkSpendingLimit(rpcClient('50'), 'user-id', 'Max');

  assert.deepEqual(result, {
    status: 'verified',
    allowed: false,
    currentSpend: 50,
    limit: 50,
    remaining: 0,
  });
});

Deno.test('reports RPC errors as unavailable for every tier', async () => {
  for (const tier of ['free', 'Max', 'Ultra']) {
    const result = await checkSpendingLimit(
      rpcClient(null, { message: 'database unavailable' }),
      'user-id',
      tier,
    );

    assertUnavailable(result, 'spending_rpc_failed');
  }
});

Deno.test('reports thrown RPC failures as unavailable', async () => {
  const client: RelayRpcClient = {
    rpc: () => Promise.reject(new Error('network unavailable')),
  };

  const result = await checkSpendingLimit(client, 'user-id', 'Ultra');

  assertUnavailable(result, 'spending_rpc_failed');
});

Deno.test(
  'rejects malformed spending data instead of treating it as zero',
  async () => {
    const malformedValues = [
      null,
      undefined,
      '',
      'not-a-number',
      true,
      {},
      [],
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];

    for (const data of malformedValues) {
      const result = await checkSpendingLimit(
        rpcClient(data),
        'user-id',
        'Ultra',
      );

      assertUnavailable(result, 'invalid_spending_response');
    }
  },
);
