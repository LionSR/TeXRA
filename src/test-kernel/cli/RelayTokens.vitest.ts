import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  RELAY_CI_TOKEN_PREFIX,
  RELAY_TOKEN_ENV_VAR,
  fetchRelayTokenStatus,
  getCachedRelayTokenState,
  getConfiguredRelayToken,
  markRelayTokenRejected,
  resetRelayTokenTierCacheForTests,
} from '@auth/relayToken';
import {
  formatMintedTokenText,
  formatTokenEnvLine,
  formatTokenListText,
  parseSetupTokenExpiresDays,
} from '@cli/commands/relayTokens';
import {
  listRelayTokens,
  mintRelayToken,
  revokeRelayToken,
} from '@cli/runtime/relayTokensClient';
import { relayTokenStillActiveNotice } from '@cli/runtime/supabaseAuth';

import { jsonResponse } from '@test/support/fetchTestUtils';

const TOKEN = `${RELAY_CI_TOKEN_PREFIX}abcdefghijklmnopqrstuvwxyz0123456789abcdEFG`;

const MINTED = {
  id: 'token-id-1',
  name: 'release pipeline',
  token_hint: '…dEFG',
  scopes: ['relay'],
  created_at: '2026-06-10T12:00:00.000Z',
  expires_at: '2026-07-10T12:00:00.000Z',
  token: TOKEN,
};

function singleFetch(response: Response): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; headers: Headers; body: unknown }>;
} {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve(response.clone());
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function pendingFetch(): {
  fetchImpl: typeof fetch;
  resolveFetch: (response: Response) => void;
} {
  let resolveFetch!: (response: Response) => void;
  const fetchImpl = (() =>
    new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;
  return { fetchImpl, resolveFetch: (response) => resolveFetch(response) };
}

describe('TEXRA_RELAY_TOKEN consumption (CI relay tokens)', () => {
  afterEach(() => {
    resetRelayTokenTierCacheForTests();
  });

  it('keeps the token prefix in sync with the Deno edge module', () => {
    // Deno edge functions cannot import src/auth, so the prefix is defined
    // twice (see the CROSS-REFERENCE comments on both constants). Guard the
    // manual sync: drift would make minted tokens silently stop
    // authenticating.
    const denoSource = readFileSync(
      new URL(
        '../../../supabase/functions/_shared/relayCiToken.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(denoSource).toContain(
      `export const RELAY_CI_TOKEN_PREFIX = '${RELAY_CI_TOKEN_PREFIX}';`,
    );
  });

  it('reads only well-formed tokens from the environment', () => {
    expect(getConfiguredRelayToken({})).toBeUndefined();
    expect(
      getConfiguredRelayToken({ [RELAY_TOKEN_ENV_VAR]: '' }),
    ).toBeUndefined();
    expect(
      getConfiguredRelayToken({ [RELAY_TOKEN_ENV_VAR]: 'not-a-relay-token' }),
    ).toBeUndefined();
    expect(
      getConfiguredRelayToken({ [RELAY_TOKEN_ENV_VAR]: `  ${TOKEN}  ` }),
    ).toBe(TOKEN);
  });

  it('resolves the owning tier via tier-config and caches the result', async () => {
    const { fetchImpl, calls } = singleFetch(
      jsonResponse({ userStatus: { tier: 'Ultra', isExpired: false } }),
    );
    expect(await fetchRelayTokenStatus(TOKEN, fetchImpl)).toEqual({
      state: 'valid',
      tier: 'Ultra',
    });
    expect(await fetchRelayTokenStatus(TOKEN, fetchImpl)).toEqual({
      state: 'valid',
      tier: 'Ultra',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/relay\/tier-config$/);
    expect(calls[0].headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(getCachedRelayTokenState(TOKEN)).toBe('valid');
  });

  it('distinguishes a rejected token from an unverifiable one', async () => {
    // Settled (valid/invalid) results cache per token, so each sub-case
    // probes a distinct token value.

    // Server answered without userStatus: the credential was not recognized
    // (tier-config falls back to the public config for bad credentials).
    const publicConfig = singleFetch(jsonResponse({ tiers: {} }));
    expect(
      await fetchRelayTokenStatus(`${TOKEN}1`, publicConfig.fetchImpl),
    ).toEqual({ state: 'invalid' });
    const unauthorized = singleFetch(jsonResponse({ error: 'nope' }, 401));
    expect(
      await fetchRelayTokenStatus(`${TOKEN}2`, unauthorized.fetchImpl),
    ).toEqual({ state: 'invalid' });

    // The check itself failed: the token may still be fine, so the result
    // is not cached and synchronous checks see no settled state.
    const offline = ((): Promise<Response> =>
      Promise.reject(new Error('socket hang up'))) as unknown as typeof fetch;
    expect(await fetchRelayTokenStatus(`${TOKEN}3`, offline)).toEqual({
      state: 'unknown',
    });
    expect(getCachedRelayTokenState(`${TOKEN}3`)).toBeUndefined();
    const serverError = singleFetch(jsonResponse({ error: 'boom' }, 503));
    expect(
      await fetchRelayTokenStatus(`${TOKEN}4`, serverError.fetchImpl),
    ).toEqual({ state: 'unknown' });
  });

  it('does not turn a malformed relay tier into free access', async () => {
    const malformed = singleFetch(
      jsonResponse({ userStatus: { tier: 'corrupted' } }),
    );

    expect(
      await fetchRelayTokenStatus(`${TOKEN}5`, malformed.fetchImpl),
    ).toEqual({ state: 'unknown' });
    expect(getCachedRelayTokenState(`${TOKEN}5`)).toBeUndefined();
  });

  it('treats a null relay tier as valid free access', async () => {
    const { fetchImpl } = singleFetch(
      jsonResponse({ userStatus: { tier: null } }),
    );

    expect(await fetchRelayTokenStatus(`${TOKEN}6`, fetchImpl)).toEqual({
      state: 'valid',
      tier: 'free',
    });
    expect(getCachedRelayTokenState(`${TOKEN}6`)).toBe('valid');
  });

  it('caches a rejection so synchronous credential checks can see it', async () => {
    const { fetchImpl, calls } = singleFetch(jsonResponse({ tiers: {} }));
    expect(await fetchRelayTokenStatus(TOKEN, fetchImpl)).toEqual({
      state: 'invalid',
    });
    expect(await fetchRelayTokenStatus(TOKEN, fetchImpl)).toEqual({
      state: 'invalid',
    });
    expect(calls).toHaveLength(1);
    expect(getCachedRelayTokenState(TOKEN)).toBe('invalid');
  });

  // Interleaving: a probe for the token is already in flight (e.g. kicked
  // off by an earlier synchronous check) when a *later* relay call gets a
  // live 401 and calls markRelayTokenRejected — evidence that is fresher
  // than whatever the in-flight probe will report. The probe then resolves
  // from data fetched before the rejection. The stale result must not
  // clobber the fresher 'invalid' (sticky until an explicit refresh — cache
  // reset — or TTL expiry), and the resolved value itself must agree with
  // the cache, otherwise a caller that trusts the return value (getUserTier,
  // getCliAuthProfile) could still treat the just-rejected token as usable.
  // The 'unknown' row matters because 'unknown' results are never cached, so
  // a naive fix that only re-checks the sticky guard for settled results
  // would return 'unknown' even though the cache already holds 'invalid' —
  // exactly the return-value/cache inconsistency this guard exists to
  // prevent.
  it.each([
    {
      name: "resolves a stale 'valid' verdict",
      response: () =>
        jsonResponse({ userStatus: { tier: 'Ultra', isExpired: false } }),
    },
    {
      name: "resolves 'unknown' from a transient 5xx",
      response: () => new Response('boom', { status: 500 }),
    },
  ])(
    'keeps a live 401 rejection sticky against a slower in-flight probe that $name',
    async ({ response }) => {
      const { fetchImpl, resolveFetch } = pendingFetch();

      const pending = fetchRelayTokenStatus(TOKEN, fetchImpl);

      // The live 401 lands and marks the token invalid while the probe above
      // is still in flight.
      markRelayTokenRejected(TOKEN);
      expect(getCachedRelayTokenState(TOKEN)).toBe('invalid');

      // The in-flight probe now resolves with a stale verdict.
      resolveFetch(response());

      await expect(pending).resolves.toEqual({ state: 'invalid' });
      expect(getCachedRelayTokenState(TOKEN)).toBe('invalid');
    },
  );

  it('warns on logout that a configured relay token stays active', () => {
    expect(relayTokenStillActiveNotice({})).toBeUndefined();
    const notice = relayTokenStillActiveNotice({
      [RELAY_TOKEN_ENV_VAR]: TOKEN,
    });
    expect(notice).toContain(RELAY_TOKEN_ENV_VAR);
    expect(notice).toContain('stays active');
    expect(notice).toContain('texra auth token revoke');
  });
});

describe('texra setup-token arguments and output', () => {
  it('parses --expires with a 30-day default and a 365-day cap', () => {
    expect(parseSetupTokenExpiresDays(undefined)).toEqual({ days: 30 });
    expect(parseSetupTokenExpiresDays('90')).toEqual({ days: 90 });
    for (const invalid of ['0', '366', 'abc', '1.5', '-3']) {
      expect(parseSetupTokenExpiresDays(invalid)).toHaveProperty('error');
    }
  });

  it('formats the env line exactly for $GITHUB_ENV-style consumption', () => {
    expect(formatTokenEnvLine(TOKEN)).toBe(`${RELAY_TOKEN_ENV_VAR}=${TOKEN}`);
  });

  it('prints the minted token once with rotation guidance', () => {
    const text = formatMintedTokenText(MINTED);
    expect(text).toContain('release pipeline');
    expect(text).toContain('expires 2026-07-10');
    expect(text).toContain('shown only once');
    expect(text).toContain(`${RELAY_TOKEN_ENV_VAR}=${TOKEN}`);
    expect(text).toContain('texra auth token revoke');
    // The plaintext token appears exactly once.
    expect(text.split(TOKEN)).toHaveLength(2);
  });

  it('summarizes token state in list output', () => {
    expect(formatTokenListText([])).toContain('texra setup-token');
    const rows = formatTokenListText([
      {
        ...MINTED,
        expires_at: '2999-01-01T00:00:00.000Z',
        last_used_at: '2026-06-12T08:00:00.000Z',
        revoked_at: null,
      },
      {
        ...MINTED,
        id: 'token-id-2',
        name: 'old token',
        last_used_at: null,
        revoked_at: '2026-06-01T00:00:00.000Z',
      },
    ]);
    expect(rows).toContain('expires 2999-01-01');
    expect(rows).toContain('last used 2026-06-12');
    expect(rows).toContain('revoked');
    expect(rows).toContain('never used');
  });
});

describe('relay-tokens edge function client', () => {
  it('mints a token with name and expiry and parses the one-time response', async () => {
    const { fetchImpl, calls } = singleFetch(jsonResponse(MINTED));
    const minted = await mintRelayToken(
      'session-jwt',
      { name: 'release pipeline', expiresInDays: 30 },
      { fetchImpl },
    );
    expect(minted.token).toBe(TOKEN);
    expect(calls[0].url).toMatch(/\/relay-tokens\/mint$/);
    expect(calls[0].headers.get('Authorization')).toBe('Bearer session-jwt');
    expect(calls[0].body).toEqual({
      name: 'release pipeline',
      expires_in_days: 30,
    });
  });

  it('surfaces server error messages verbatim', async () => {
    const { fetchImpl } = singleFetch(
      jsonResponse({ error: 'Active CI token limit reached (10).' }, 409),
    );
    await expect(
      mintRelayToken('session-jwt', {}, { fetchImpl }),
    ).rejects.toThrow('Active CI token limit reached (10).');
  });

  it('lists token metadata and revokes by id', async () => {
    const listFetch = singleFetch(
      jsonResponse({
        tokens: [{ ...MINTED, last_used_at: null, revoked_at: null }],
      }),
    );
    const tokens = await listRelayTokens('session-jwt', {
      fetchImpl: listFetch.fetchImpl,
    });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token_hint).toBe('…dEFG');
    expect(listFetch.calls[0].url).toMatch(/\/relay-tokens\/list$/);

    const revokeFetch = singleFetch(
      jsonResponse({ revoked: { id: 'token-id-1', name: 'release pipeline' } }),
    );
    const revoked = await revokeRelayToken('session-jwt', 'token-id-1', {
      fetchImpl: revokeFetch.fetchImpl,
    });
    expect(revoked.name).toBe('release pipeline');
    expect(revokeFetch.calls[0].body).toEqual({ id: 'token-id-1' });
  });
});
