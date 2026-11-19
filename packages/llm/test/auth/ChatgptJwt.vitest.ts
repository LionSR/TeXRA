import { describe, expect, it } from 'vitest';

import { chatgptPolicy } from '../../src/oauth/chatgpt/chatgptProvider.js';

/** An access token the claim decoder reads as carrying no claims. */
const OPAQUE_ACCESS_TOKEN = 'opaque-access-token';

/**
 * The claims a ChatGPT sign-in stores from its token grant, read through the
 * policy's `buildSession`: the id_token's, falling back field by field to the
 * access_token's. An absent access token is one that carries no claims.
 */
function storedClaims(
  idToken: string | undefined,
  accessToken: string | undefined,
) {
  const { accountId, email, planType } = chatgptPolicy({
    name: 'Synthetic',
    id: 'synthetic',
  }).buildSession(
    {
      access_token: accessToken ?? OPAQUE_ACCESS_TOKEN,
      id_token: idToken,
      refresh_token: 'refresh-token',
      expires_in: 3600,
    },
    'refresh-token',
    0,
  );
  return { accountId, email, planType };
}

/** Build a JWT with the given payload (signature is irrelevant — we only decode). */
function makeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${body}.signature`;
}

describe('ChatGPT JWT claim extraction', () => {
  it.each([
    {
      name: 'reads the nested https://api.openai.com/auth claim',
      id: makeJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-nested' },
        email: 'nested@b.com',
      }),
      access: undefined,
      claims: { accountId: 'acct-nested', email: 'nested@b.com' },
    },
    {
      name: 'falls back field by field when the id_token lacks a claim',
      id: makeJwt({ email: 'from-id-token@example.com' }),
      access: makeJwt({ chatgpt_account_id: 'from-access-token' }),
      claims: {
        accountId: 'from-access-token',
        email: 'from-id-token@example.com',
      },
    },
    {
      // A wrong-typed sibling degrades to undefined on its own rather than
      // dropping the whole payload.
      name: 'keeps a valid claim when a sibling claim is malformed',
      id: makeJwt({
        chatgpt_account_id: 'acct-top',
        organizations: 'garbage',
        email: 123,
      }),
      access: undefined,
      claims: { accountId: 'acct-top' },
    },
  ])('$name', ({ id, access, claims }) => {
    expect(storedClaims(id, access)).toEqual(claims);
  });
});
