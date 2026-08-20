/**
 * Schemas + types for the xAI (Grok) OAuth token bundle.
 * Error kinds match the shared subscription OAuth vocabulary.
 */
import { z } from 'zod';

import { GROK_AUTH } from '@shared/copy/accountAuth';

import { XAI_DEFAULT_EXPIRES_IN_SEC } from './xaiConstants';
import {
  SubscriptionOAuthError,
  type SubscriptionOAuthErrorKind,
} from '../oauth/subscriptionOAuthError';

/** Raw response from the OAuth token endpoint (code exchange + refresh). */
export const XaiTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullish(),
  id_token: z.string().min(1).nullish(),
  // Provider-boundary guard: absent or non-positive expires_in is not a
  // security decision — fall back to a short default and let JWT exp / 401
  // drive the real refresh. Prefer access JWT exp in buildSession when present.
  expires_in: z.coerce
    .number()
    .positive()
    .catch(XAI_DEFAULT_EXPIRES_IN_SEC)
    .prefault(XAI_DEFAULT_EXPIRES_IN_SEC),
  token_type: z.string().nullish(),
  scope: z.string().nullish(),
});
export type XaiTokenResponse = z.infer<typeof XaiTokenResponseSchema>;

/** The persisted OAuth session bundle. */
export const XaiSessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  idToken: z.string().min(1).optional(),
  expiresAtMs: z.number(),
  email: z.string().min(1).optional(),
});
export type XaiSession = z.infer<typeof XaiSessionSchema>;

export function xaiAccountLabel(
  account: { readonly email?: string | null } | null | undefined,
): string {
  return account?.email ?? 'your Grok account';
}

/** RFC 8628 device-code authorization response. */
export const XaiDeviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().min(1).nullish(),
  expires_in: z.coerce.number().positive().nullish().catch(undefined),
  interval: z.coerce.number().positive().nullish().catch(undefined),
});
export type XaiDeviceCode = z.infer<typeof XaiDeviceCodeSchema>;

export class XaiAuthError extends SubscriptionOAuthError {
  constructor(
    message: string,
    kind: SubscriptionOAuthErrorKind,
    status?: number,
    options?: ErrorOptions,
  ) {
    super(message, kind, status, options);
    this.name = 'XaiAuthError';
  }
}

export function formatXaiAuthUnavailableMessage(error: XaiAuthError): string {
  const turnOff = `turn off "${GROK_AUTH.preferLabel}".`;
  const action = error.needsReauth
    ? `${GROK_AUTH.signInLabel} again, or ${turnOff}`
    : `Try again in a moment, or ${turnOff}`;
  return `${GROK_AUTH.subscriptionLabel} unavailable: ${error.message} ${action}`;
}
