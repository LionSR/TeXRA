/**
 * Relay Tokens Edge Function - CI relay token management (texra setup-token).
 *
 * Mints, lists, and revokes long-lived CI relay tokens. The plaintext token
 * is returned exactly once at mint time; only its SHA-256 hash plus audit
 * metadata (name, hint, scopes, expiry, last use) is persisted. The relay
 * and log-usage functions accept the token as a bearer credential via
 * _shared/relayCiToken.ts.
 *
 * Routes (all require a normal user JWT — a CI token can NOT manage tokens):
 * - POST /mint   - { name?, expires_in_days? } -> plaintext token (once)
 * - GET  /list   - token metadata for the signed-in user (never the token)
 * - POST /revoke - { id } -> marks the token revoked
 *
 * Security:
 * - Tokens are high-entropy (32 random bytes), prefixed `texra_relay_`,
 *   stored hash-at-rest; rows are service-role only
 * - Scope is fixed to relay invocation; expiry is capped at 365 days
 * - Active tokens per user are capped to bound the blast radius of a leak
 */

import { Hono } from '@hono/hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticateJwt, bearerToken } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { randomBase64Url, sha256Hex } from '../_shared/crypto.ts';
import { adminClient } from '../_shared/edgeClients.ts';
import { RELAY_CI_TOKEN_PREFIX } from '../_shared/relayCiToken.ts';
import { errorResponse, jsonResponse } from '../_shared/responses.ts';

// =============================================================================
// Constants
// =============================================================================

const TOKEN_RANDOM_BYTES = 32;
const DEFAULT_EXPIRES_IN_DAYS = 30;
const MAX_EXPIRES_IN_DAYS = 365;
const MAX_ACTIVE_TOKENS_PER_USER = 10;
const MAX_NAME_LENGTH = 80;
const TOKEN_HINT_CHARS = 4;
const TOKEN_SCOPES = ['relay'];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// =============================================================================
// Hono App
// =============================================================================

type Variables = {
  supabase: SupabaseClient;
  userId: string;
};

// The edge runtime hands over paths including the function slug
// (/relay-tokens/mint), same as the other auth functions.
const app = new Hono<{ Variables: Variables }>().basePath('/relay-tokens');

app.use('*', async (c, next) => {
  const response = handleCors(c.req.raw);
  if (response) return response;
  await next();
});

// Authenticate every route with a user JWT. CI tokens are not JWTs, so they
// fail here by construction — a leaked CI token cannot mint or revoke tokens.
app.use('*', async (c, next) => {
  if (!adminClient) {
    return errorResponse(c.req.raw, 'Server configuration error', 500);
  }
  const auth = await authenticateJwt(bearerToken(c.req.raw));
  if (!auth) {
    return errorResponse(c.req.raw, 'Sign in before managing CI tokens', 401);
  }
  c.set('supabase', adminClient);
  c.set('userId', auth.user.id);
  await next();
});

// =============================================================================
// Helpers
// =============================================================================

function tokenHint(token: string): string {
  return `…${token.slice(-TOKEN_HINT_CHARS)}`;
}

function defaultTokenName(): string {
  return `CI token (${new Date().toISOString().slice(0, 10)})`;
}

// =============================================================================
// Routes
// =============================================================================

// POST /mint - Create a CI relay token. Plaintext is returned exactly once.
app.post('/mint', async (c) => {
  try {
    const supabase = c.get('supabase');
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({}));

    const rawName = typeof body?.name === 'string' ? body.name.trim() : '';
    const name = (rawName || defaultTokenName()).slice(0, MAX_NAME_LENGTH);

    const rawExpires = body?.expires_in_days;
    const expiresInDays =
      rawExpires == null ? DEFAULT_EXPIRES_IN_DAYS : Number(rawExpires);
    if (
      !Number.isInteger(expiresInDays) ||
      expiresInDays < 1 ||
      expiresInDays > MAX_EXPIRES_IN_DAYS
    ) {
      return errorResponse(
        c.req.raw,
        `expires_in_days must be an integer between 1 and ${MAX_EXPIRES_IN_DAYS}`,
        400,
      );
    }

    const { count, error: countError } = await supabase
      .from('relay_ci_tokens')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString());
    if (countError) {
      console.error('[RELAY_TOKENS] count failed:', countError.message);
      return errorResponse(c.req.raw, 'Failed to mint token', 500);
    }
    if ((count ?? 0) >= MAX_ACTIVE_TOKENS_PER_USER) {
      return errorResponse(
        c.req.raw,
        `Active CI token limit reached (${MAX_ACTIVE_TOKENS_PER_USER}). Revoke unused tokens first.`,
        409,
      );
    }

    const token = `${RELAY_CI_TOKEN_PREFIX}${randomBase64Url(
      TOKEN_RANDOM_BYTES,
    )}`;
    const expiresAt = new Date(Date.now() + expiresInDays * MS_PER_DAY);
    const { data, error } = await supabase
      .from('relay_ci_tokens')
      .insert({
        user_id: userId,
        name,
        token_hash: await sha256Hex(token),
        token_hint: tokenHint(token),
        scopes: TOKEN_SCOPES,
        expires_at: expiresAt.toISOString(),
      })
      .select('id, name, token_hint, scopes, created_at, expires_at')
      .single();
    if (error || !data) {
      console.error('[RELAY_TOKENS] insert failed:', error?.message);
      return errorResponse(c.req.raw, 'Failed to mint token', 500);
    }

    console.log(`[RELAY_TOKENS] minted token ${data.id} for user ${userId}`);
    return jsonResponse(c.req.raw, { ...data, token }, 200);
  } catch (error) {
    console.error('[RELAY_TOKENS] mint error:', error);
    return errorResponse(c.req.raw, 'Internal server error', 500);
  }
});

// GET /list - Token metadata for the signed-in user (never the token itself).
app.get('/list', async (c) => {
  try {
    const { data, error } = await c
      .get('supabase')
      .from('relay_ci_tokens')
      .select(
        'id, name, token_hint, scopes, created_at, expires_at, last_used_at, revoked_at',
      )
      .eq('user_id', c.get('userId'))
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[RELAY_TOKENS] list failed:', error.message);
      return errorResponse(c.req.raw, 'Failed to list tokens', 500);
    }
    return jsonResponse(c.req.raw, { tokens: data ?? [] }, 200);
  } catch (error) {
    console.error('[RELAY_TOKENS] list error:', error);
    return errorResponse(c.req.raw, 'Internal server error', 500);
  }
});

// POST /revoke - Revoke one of the signed-in user's tokens by id.
app.post('/revoke', async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => null);
    const id = typeof body?.id === 'string' ? body.id : '';
    if (!id) {
      return errorResponse(c.req.raw, 'id required', 400);
    }

    const { data, error } = await c
      .get('supabase')
      .from('relay_ci_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .is('revoked_at', null)
      .select('id, name');
    if (error) {
      console.error('[RELAY_TOKENS] revoke failed:', error.message);
      return errorResponse(c.req.raw, 'Failed to revoke token', 500);
    }
    if (!data?.length) {
      return errorResponse(
        c.req.raw,
        'Token not found or already revoked',
        404,
      );
    }

    console.log(`[RELAY_TOKENS] revoked token ${id} for user ${userId}`);
    return jsonResponse(c.req.raw, { revoked: data[0] }, 200);
  } catch (error) {
    console.error('[RELAY_TOKENS] revoke error:', error);
    return errorResponse(c.req.raw, 'Internal server error', 500);
  }
});

// 404 for other routes
app.all('*', (c) => errorResponse(c.req.raw, 'Not found', 404));

Deno.serve(app.fetch);
