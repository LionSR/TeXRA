import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { codexCoordinator } from '@texra-ai/llm/node';
import type { CredentialStore } from '@texra-ai/llm';

/** An access token the claim decoder reads as carrying no claims. */
const OPAQUE_ACCESS_TOKEN = 'opaque-access-token';

/**
 * The claims a ChatGPT sign-in stores from its token grant, read through the
 * coordinator's `storeTokens`: the id_token's, falling back field by field to
 * the access_token's. An absent access token is one that carries no claims.
 */
function storedClaims(
  idToken: string | undefined,
  accessToken: string | undefined,
) {
  const signedOut: CredentialStore = {
    get: () => Effect.succeed(undefined),
    set: () => Effect.void,
    delete: () => Effect.void,
  };
  const { accountId, email, planType } = Effect.runSync(
    codexCoordinator(signedOut).storeTokens({
      access_token: accessToken ?? OPAQUE_ACCESS_TOKEN,
      id_token: idToken,
      refresh_token: 'refresh-token',
      expires_in: 3600,
    }),
  );
  return { accountId, email, planType };
}

/** Build a JWT with the given payload (signature is irrelevant — we only decode). */
function makeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${body}.signature`;
}

describe('codex JWT claim extraction', () => {
  it('reads the top-level chatgpt_account_id', () => {
    const jwt = makeJwt({ chatgpt_account_id: 'acct-top', email: 'a@b.com' });
    expect(storedClaims(jwt, undefined)).toEqual({
      accountId: 'acct-top',
      email: 'a@b.com',
    });
  });

  it('reads the nested https://api.openai.com/auth claim', () => {
    const jwt = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-nested' },
      email: 'nested@b.com',
    });
    expect(storedClaims(jwt, undefined)).toEqual({
      accountId: 'acct-nested',
      email: 'nested@b.com',
    });
  });

  it('falls back to organizations[0].id', () => {
    const jwt = makeJwt({
      organizations: [{ id: 'org-123' }, { id: 'org-456' }],
    });
    expect(storedClaims(jwt, undefined).accountId).toBe('org-123');
  });

  it('prefers the id_token over the access_token', () => {
    const idToken = makeJwt({ chatgpt_account_id: 'from-id-token' });
    const accessToken = makeJwt({ chatgpt_account_id: 'from-access-token' });
    expect(storedClaims(idToken, accessToken).accountId).toBe('from-id-token');
  });

  it('falls back field-by-field when id_token lacks claims', () => {
    const idToken = makeJwt({ email: 'from-id-token@example.com' });
    const accessToken = makeJwt({ chatgpt_account_id: 'from-access-token' });
    expect(storedClaims(idToken, accessToken)).toEqual({
      accountId: 'from-access-token',
      email: 'from-id-token@example.com',
    });
  });

  it('falls back to access_token when id_token is malformed', () => {
    const accessToken = makeJwt({
      chatgpt_account_id: 'from-access-token',
      email: 'from-access-token@example.com',
    });
    expect(storedClaims('not-a-jwt', accessToken)).toEqual({
      accountId: 'from-access-token',
      email: 'from-access-token@example.com',
    });
  });

  it('keeps a valid claim when a sibling claim is malformed', () => {
    // A wrong-typed / garbage sibling must degrade to undefined on its own
    // rather than dropping the whole payload (per-field tolerance).
    const jwt = makeJwt({
      chatgpt_account_id: 'acct-top',
      organizations: 'garbage',
      email: 123,
    });
    expect(storedClaims(jwt, undefined)).toEqual({
      accountId: 'acct-top',
    });
  });

  it('returns empty claims for malformed or missing tokens', () => {
    expect(storedClaims(undefined, undefined)).toEqual({});
    expect(storedClaims('not-a-jwt', undefined)).toEqual({});
    expect(storedClaims('a.!!!notbase64json!!!.c', undefined)).toEqual({});
  });
});
