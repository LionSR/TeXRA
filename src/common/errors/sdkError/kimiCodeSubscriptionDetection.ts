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
 * (parallel to the Codex `usage_limit_reached` affordance). The bound
 * credential route the run stamped on the failure keeps the Moonshot open
 * platform from being misread as a subscription limit.
 */

import { matchUsageLimitMessage, type QuotaLimitInfo } from './errorInspection';
import { detectSdkUsageRoute } from './errorMetadata';

/** The distinctive Kimi Code membership-exhaustion phrase. */
const USAGE_LIMIT_PATTERN =
  /usage limit for this billing cycle|quota will be refreshed in the next cycle/i;

/**
 * Parse a Kimi Code usage-limit error, returning the reset details or `null`
 * when the error is not a Kimi Code subscription usage-limit. Route stamp plus
 * body inspection, no clock reads.
 */
export function parseKimiCodeSubscriptionLimit(
  err: unknown,
  rawErrorBody: unknown,
): QuotaLimitInfo | null {
  if (detectSdkUsageRoute(err) !== 'kimi-code-subscription') return null;
  return matchUsageLimitMessage(err, rawErrorBody, USAGE_LIMIT_PATTERN);
}
