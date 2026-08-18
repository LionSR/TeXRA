import { formatResetDuration } from './chatgptSubscriptionDetection';
import {
  errorBodyCandidates,
  pickNumberField,
  pickStringField,
} from './errorInspection';
import { detectSdkCredentialRoute } from './sdkRequestEndpoint';

/**
 * Detection + formatting for the Grok (xAI SuperGrok) subscription usage
 * limit. SuperGrok hits the same `api.x.ai` surface as an API key, so the
 * request's credential-route stamp is the only reliable "this was a
 * subscription call" signal. Combined with quota/usage-limit wording (and
 * not a transient rate-limit phrase) that identifies a plan whose quota
 * ran out — the signal that lets the retry UI offer a switch to the
 * stored xAI API key.
 */
export interface XaiSubscriptionLimit {
  readonly resetsInSeconds?: number;
}

/** Distinctive SuperGrok / xAI plan-quota phrasing. Transient 429 rate
 *  limits ("rate limit", "too many requests") do not match and must not
 *  flip the preference. */
const USAGE_LIMIT_PATTERN =
  /usage limit|quota.{0,24}(exceeded|exhausted|reached)|exceeded your (usage|quota)|weekly (usage )?limit|monthly (usage )?limit/i;

/**
 * Parse a Grok-subscription usage-limit error, or `null` when the error is
 * not a SuperGrok quota exhaustion. Requires the subscription route stamp
 * so a direct xAI API-key 429 cannot be misread as plan exhaustion.
 */
export function parseXaiSubscriptionLimit(
  err: unknown,
  rawErrorBody: unknown,
): XaiSubscriptionLimit | null {
  if (detectSdkCredentialRoute(err) !== 'xai-subscription') return null;

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

/** Human-readable message for a Grok-subscription usage-limit error. */
export function describeXaiSubscriptionLimit(
  info: XaiSubscriptionLimit,
): string {
  const reset =
    info.resetsInSeconds !== undefined
      ? ` Resets in ${formatResetDuration(info.resetsInSeconds)}.`
      : '';
  return (
    `Grok subscription usage limit reached.${reset}` +
    ' Switch to your own xAI API key to keep working, or wait until the limit resets.'
  );
}
