import { KIMI_CODE_BASE_URL } from '@shared/constants/providers';

import { formatResetDuration } from './chatgptSubscriptionDetection';
import {
  errorBodyCandidates,
  pickNumberField,
  pickStringField,
} from './errorInspection';
import { detectSdkRequestBaseURL } from './sdkRequestEndpoint';

/**
 * Detection + formatting for the Kimi Code (Moonshot coding-subscription)
 * usage limit. When a user drives Kimi-subscription-eligible models through
 * their Kimi Code membership (the `api.kimi.com/coding/v1` coding endpoint),
 * the backend rejects requests once the membership's usage quota is exhausted
 * with a distinctive message:
 *
 *   "You've reached your usage limit for this billing cycle. Your quota will
 *    be refreshed in the next cycle. To continue now, purchase extra usage or
 *    upgrade your plan: https://www.kimi.com/code/#pricing"
 *
 * The "usage limit for this billing cycle" / "quota will be refreshed in the
 * next cycle" phrasing is unique to the Kimi Code membership backend, so
 * matching it reliably identifies a subscription request whose quota ran out —
 * the signal that lets the retry UI offer "switch to your own API key"
 * (parallel to the Codex `usage_limit_reached` affordance). The endpoint guard
 * (`api.kimi.com/coding/v1`) keeps the Moonshot open platform from being
 * misread as a subscription limit.
 */
export interface KimiCodeSubscriptionLimit {
  readonly resetsInSeconds?: number;
}

/** The distinctive Kimi Code membership-exhaustion phrase. */
const USAGE_LIMIT_PATTERN =
  /usage limit for this billing cycle|quota will be refreshed in the next cycle/i;

/** Whether the error's request targeted the Kimi Code coding endpoint. The
 *  endpoint comes from the request-config side channel
 *  ({@link detectSdkRequestBaseURL}): the OpenAI SDK's `APIError` carries no
 *  request config of its own, so the handler boundary records it there. */
function isKimiCodeEndpointError(err: unknown): boolean {
  return detectSdkRequestBaseURL(err)?.includes(KIMI_CODE_BASE_URL) === true;
}

/**
 * Parse a Kimi Code usage-limit error, returning the reset details or `null`
 * when the error is not a Kimi Code subscription usage-limit. Mirrors
 * {@link parseChatGptSubscriptionLimit}: pure body inspection, no clock reads.
 */
export function parseKimiCodeSubscriptionLimit(
  err: unknown,
  rawErrorBody: unknown,
): KimiCodeSubscriptionLimit | null {
  if (!isKimiCodeEndpointError(err)) return null;

  const message =
    errorBodyCandidates(rawErrorBody)
      .map((candidate) => pickStringField(candidate, 'message'))
      .find((candidate) => candidate !== undefined) ??
    (typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : undefined);
  if (!message || !USAGE_LIMIT_PATTERN.test(message)) return null;

  const resetsInSeconds = errorBodyCandidates(rawErrorBody)
    .map((candidate) => pickNumberField(candidate, 'resets_in_seconds'))
    .find((value): value is number => value !== undefined);

  return { resetsInSeconds };
}

/**
 * Human-readable message for a Kimi Code usage-limit error: how long until the
 * quota resets (when reported) and the actionable next step.
 */
export function describeKimiCodeSubscriptionLimit(
  info: KimiCodeSubscriptionLimit,
): string {
  // Shared with the ChatGPT and GLM detectors so all three providers render the
  // same reset-window format for the same `resets_in_seconds` field.
  const reset =
    info.resetsInSeconds !== undefined
      ? ` Resets in ${formatResetDuration(info.resetsInSeconds)}.`
      : '';
  return (
    `Kimi Code subscription usage limit reached.${reset}` +
    ' Switch to your own Moonshot API key to keep working, or wait until the limit resets.'
  );
}
