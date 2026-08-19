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
