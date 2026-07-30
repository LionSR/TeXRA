// Client for the relay-tokens edge function (texra setup-token / texra auth
// token). Protocol layer only: minting requires a normal user session JWT —
// never a CI token — and the plaintext token appears exactly once in the
// mint response. Command wiring lives in `commands/relayTokens.ts`.

import { z } from 'zod';

import { RELAY_TOKENS_BASE_URL } from '@auth/config';
import { fetchWithTimeout } from '@auth/fetchWithTimeout';

const RELAY_TOKENS_REQUEST_TIMEOUT_MS = 30000;

const RelayTokenInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  token_hint: z.string(),
  scopes: z.array(z.string()).catch(['relay']),
  created_at: z.string(),
  expires_at: z.string(),
  last_used_at: z.string().nullish(),
  revoked_at: z.string().nullish(),
});
export type RelayTokenInfo = z.infer<typeof RelayTokenInfoSchema>;

const MintedRelayTokenSchema = RelayTokenInfoSchema.omit({
  last_used_at: true,
  revoked_at: true,
}).extend({
  token: z.string().min(1),
});
export type MintedRelayToken = z.infer<typeof MintedRelayTokenSchema>;

export interface RelayTokensClientHooks {
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the relay-tokens edge function URL. */
  readonly baseUrl?: string;
}

export interface MintRelayTokenInput {
  readonly name?: string;
  readonly expiresInDays?: number;
}

async function relayTokensRequest(
  accessToken: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  hooks: RelayTokensClientHooks,
): Promise<unknown> {
  const response = await fetchWithTimeout(
    `${hooks.baseUrl ?? RELAY_TOKENS_BASE_URL}${path}`,
    {
      method: init.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    },
    RELAY_TOKENS_REQUEST_TIMEOUT_MS,
    'CI token request timed out',
    hooks.fetchImpl,
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorBody = z.object({ error: z.string() }).safeParse(body);
    throw new Error(
      errorBody.success
        ? errorBody.data.error
        : `CI token request failed (HTTP ${response.status})`,
    );
  }
  return body;
}

/** Mint a CI relay token. The returned plaintext is shown exactly once. */
export async function mintRelayToken(
  accessToken: string,
  input: MintRelayTokenInput = {},
  hooks: RelayTokensClientHooks = {},
): Promise<MintedRelayToken> {
  const body = await relayTokensRequest(
    accessToken,
    '/mint',
    {
      method: 'POST',
      body: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.expiresInDays !== undefined && {
          expires_in_days: input.expiresInDays,
        }),
      },
    },
    hooks,
  );
  const parsed = MintedRelayTokenSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('CI token mint returned an unexpected response.');
  }
  return parsed.data;
}

/** List the signed-in user's CI token metadata (never the tokens). */
export async function listRelayTokens(
  accessToken: string,
  hooks: RelayTokensClientHooks = {},
): Promise<readonly RelayTokenInfo[]> {
  const body = await relayTokensRequest(
    accessToken,
    '/list',
    { method: 'GET' },
    hooks,
  );
  const parsed = z
    .object({ tokens: z.array(RelayTokenInfoSchema) })
    .safeParse(body);
  if (!parsed.success) {
    throw new Error('CI token list returned an unexpected response.');
  }
  return parsed.data.tokens;
}

/** Revoke one of the signed-in user's CI tokens by id. */
export async function revokeRelayToken(
  accessToken: string,
  id: string,
  hooks: RelayTokensClientHooks = {},
): Promise<{ id: string; name: string }> {
  const body = await relayTokensRequest(
    accessToken,
    '/revoke',
    { method: 'POST', body: { id } },
    hooks,
  );
  const parsed = z
    .object({ revoked: z.object({ id: z.string(), name: z.string() }) })
    .safeParse(body);
  if (!parsed.success) {
    throw new Error('CI token revoke returned an unexpected response.');
  }
  return parsed.data.revoked;
}
