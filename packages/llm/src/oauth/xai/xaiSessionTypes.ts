/**
 * Schemas + types for the xAI (Grok) OAuth token bundle.
 */
import { z } from 'zod';

import { XAI_DEFAULT_EXPIRES_IN_SEC } from './xaiConstants.js';
import { SubscriptionSessionBaseSchema } from '../subscriptionSessionSchema.js';

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

/** The persisted OAuth session bundle. */
export const XaiSessionSchema = SubscriptionSessionBaseSchema.extend({
  email: z.string().min(1).optional(),
});
export type XaiSession = z.infer<typeof XaiSessionSchema>;

/** RFC 8628 device-code authorization response. */
export const XaiDeviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().min(1).nullish(),
  expires_in: z.coerce.number().positive().nullish().catch(undefined),
  interval: z.coerce.number().positive().nullish().catch(undefined),
});
