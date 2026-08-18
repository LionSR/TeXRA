import prettyMilliseconds from 'pretty-ms';

import { capitalize } from '@utils/text/stringUtils';

import {
  errorBodyCandidates,
  pickNumberField,
  pickStringField,
} from './errorInspection';

/**
 * Detection + formatting for the ChatGPT-subscription (Codex backend) usage
 * limit. When a user drives Codex-eligible models through their ChatGPT
 * subscription (see `@auth/codex`), the backend rejects requests once the
 * plan's quota is exhausted with a distinctive body:
 *
 *   { "type": "usage_limit_reached", "message": "...", "plan_type": "pro",
 *     "resets_at": 1782634869, "resets_in_seconds": 159728 }
 *
 * This shape is ONLY ever returned by the Codex backend — a direct OpenAI API
 * key reports rate limits as `rate_limit_exceeded` / `insufficient_quota`
 * instead — so matching `type === 'usage_limit_reached'` reliably identifies a
 * subscription request whose quota ran out, the signal that lets the retry UI
 * offer "switch to your own API key". Pure body inspection over the raw
 * error body candidates.
 */
export interface ChatGptSubscriptionLimit {
  readonly planType?: string;
  readonly resetsInSeconds?: number;
}

/**
 * Parse a Codex `usage_limit_reached` body, returning the plan/reset details
 * or `null` when the body is not a subscription usage-limit error. Handles
 * both the direct shape and the SDK-enveloped `{ error: { ... } }` form.
 */
export function parseChatGptSubscriptionLimit(
  rawErrorBody: unknown,
): ChatGptSubscriptionLimit | null {
  for (const candidate of errorBodyCandidates(rawErrorBody)) {
    if (pickStringField(candidate, 'type') !== 'usage_limit_reached') continue;
    return {
      planType: pickStringField(candidate, 'plan_type'),
      resetsInSeconds: pickNumberField(candidate, 'resets_in_seconds'),
    };
  }
  return null;
}

/**
 * Format a coarse "1d 20h" / "20h 22m" / "5m" duration from a second count.
 * Day+hour, hour+minute, or minute granularity is plenty for a reset-window
 * hint; sub-minute collapses to a friendly phrase. Pure (no clock read), so it
 * stays usable from the synchronous error formatter. Backed by `pretty-ms`
 * (top 2 units) rather than hand-rolled day/hour/minute math — minutes are
 * truncated once the duration reaches a day, matching the "day granularity
 * drops minutes" rule of the original hand-rolled formatter (pretty-ms would
 * otherwise back-fill a zero hour component with minutes, e.g. "1d 58m").
 * Shared with {@link describeGlmCodingPlanLimit}, which formats its reset
 * hint identically.
 */
export function formatResetDuration(totalSeconds: number): string {
  const wholeMinutes = Math.floor(Math.max(0, totalSeconds) / 60);
  if (wholeMinutes === 0) return 'less than a minute';
  const flooredMinutes =
    wholeMinutes >= 1440 ? wholeMinutes - (wholeMinutes % 60) : wholeMinutes;
  return prettyMilliseconds(flooredMinutes * 60_000, { unitCount: 2 });
}

/**
 * Human-readable message for a subscription usage-limit error: plan name (when
 * present), how long until the quota resets (from `resets_in_seconds`, no clock
 * read needed), and the actionable next step.
 */
export function describeChatGptSubscriptionLimit(
  info: ChatGptSubscriptionLimit,
): string {
  const plan = info.planType ? ` (${capitalize(info.planType)} plan)` : '';
  const reset =
    info.resetsInSeconds !== undefined
      ? ` Resets in ${formatResetDuration(info.resetsInSeconds)}.`
      : '';
  return (
    `ChatGPT subscription usage limit reached${plan}.${reset}` +
    ' Switch to your own OpenAI API key to keep working, or wait until the limit resets.'
  );
}
