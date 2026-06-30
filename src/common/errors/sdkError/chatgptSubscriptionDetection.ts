import { isObject, isString } from '@utils/core';
import { capitalize } from '@utils/text/stringUtils';

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
 * offer "switch to your own API key" (parallel to the relay monthly-limit
 * affordance). Pure body inspection, mirroring {@link relayDetection}.
 */
export interface ChatGptSubscriptionLimit {
  readonly planType?: string;
  readonly resetsInSeconds?: number;
}

function pickStringField(value: unknown, key: string): string | undefined {
  if (!isObject(value)) return undefined;
  const field = value[key];
  return isString(field) && field.trim().length > 0 ? field : undefined;
}

function pickNumberField(value: unknown, key: string): number | undefined {
  if (!isObject(value)) return undefined;
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field)
    ? field
    : undefined;
}

/**
 * Parse a Codex `usage_limit_reached` body, returning the plan/reset details
 * or `null` when the body is not a subscription usage-limit error. Handles
 * both the direct shape and the SDK-enveloped `{ error: { ... } }` form.
 */
export function parseChatGptSubscriptionLimit(
  rawErrorBody: unknown,
): ChatGptSubscriptionLimit | null {
  if (!isObject(rawErrorBody)) return null;
  const candidates = [rawErrorBody, rawErrorBody.error];
  for (const candidate of candidates) {
    if (pickStringField(candidate, 'type') !== 'usage_limit_reached') continue;
    return {
      planType: pickStringField(candidate, 'plan_type'),
      resetsInSeconds: pickNumberField(candidate, 'resets_in_seconds'),
    };
  }
  return null;
}

/**
 * Format a coarse "1d 20h" / "44h 22m" / "5m" duration from a second count.
 * Day+hour, hour+minute, or minute granularity is plenty for a reset-window
 * hint; sub-minute collapses to a friendly phrase. Pure (no clock read), so it
 * stays usable from the synchronous error formatter.
 */
function formatResetDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  return parts.length > 0 ? parts.join(' ') : 'less than a minute';
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
