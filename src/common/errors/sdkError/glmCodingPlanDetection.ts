import prettyMilliseconds from 'pretty-ms';

import {
  errorBodyCandidates,
  pickNumberField,
  pickStringField,
} from './errorInspection';

/**
 * Detection + formatting for the GLM Coding Plan usage limit.
 *
 * When a user routes GLM models through their GLM Coding Plan (the
 * `api.z.ai/api/coding/paas/v4` coding endpoint), the backend rejects requests
 * once the plan's usage quota is exhausted with a distinctive business error
 * code in the OpenAI-compatible envelope:
 *
 *   { "error": { "code": "1310", "message": "Weekly/Monthly Limit Exhausted..." } }
 *
 * The quota-exhaustion codes (1308–1321) are unique to the GLM
 * Coding Plan backend — a regular GLM pay-as-you-go request reports rate limits
 * as 1302/1305 instead — so matching the `code` field reliably identifies a
 * coding-plan request whose quota ran out. That is the signal that lets the
 * retry UI offer "switch to the regular GLM endpoint" (turn off the Coding Plan
 * toggle so requests route through `/api/paas/v4` instead).
 *
 * The reset hint is derived from either a `resets_in_seconds` field or the
 * absolute reset timestamp embedded in the message (e.g. "您的限额将在
 * 2026-08-08 11:32:36 重置" — a UTC+8 China-time timestamp). The timestamp is
 * parsed as UTC+8 and converted to seconds-until-reset.
 */
export interface GlmCodingPlanLimit {
  /** Reset hint when the backend reports one (seconds until quota resets). */
  readonly resetsInSeconds?: number;
}

/** GLM Coding Plan quota-exhaustion business error codes (all HTTP 429). */
const GLM_CODING_PLAN_EXHAUSTION_CODES: ReadonlySet<string> = new Set([
  '1308', // Usage limit reached for {number} {unit}
  '1309', // GLM Coding Plan package expired
  '1310', // Weekly/Monthly Limit Exhausted
  '1316', // Usage limit reached for the past 5 hours
  '1317', // Usage limit reached for the past 7 days
  '1318', // Usage limit reached for the past 5 hours (monthly spend limit)
  '1319', // Usage limit reached for the past 7 days (monthly spend limit)
  '1320', // Usage limit reached for the past 5 hours (monthly spend limit)
  '1321', // Usage limit reached for the past 7 days (monthly spend limit)
]);

/** GLM Coding Plan transient rate-limit / overload codes (all HTTP 429). These
 *  are retryable, not quota exhaustion — a moment's pause clears them. */
const GLM_CODING_PLAN_RATE_LIMIT_CODES: ReadonlySet<string> = new Set([
  '1302', // Rate limit reached for requests
  '1305', // The service may be temporarily overloaded
]);

/** UTC+8 (China Standard Time) offset in milliseconds. */
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Match a `YYYY-MM-DD HH:MM:SS` reset timestamp in the error message. */
const RESET_TIMESTAMP_PATTERN = /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/;

/** Seconds until the quota resets, from a UTC+8 `YYYY-MM-DD HH:MM:SS` timestamp. */
function secondsUntilReset(timestamp: string): number | undefined {
  const match = RESET_TIMESTAMP_PATTERN.exec(timestamp);
  if (!match) return undefined;
  const [date, time] = [match[1], match[2]];
  // Parse as UTC+8: treat the wall-clock as UTC, then subtract the CST offset
  // to get the true UTC instant.
  const utcMs = Date.parse(`${date}T${time}Z`);
  if (Number.isNaN(utcMs)) return undefined;
  const resetMs = utcMs - CST_OFFSET_MS;
  return Math.max(0, Math.floor((resetMs - Date.now()) / 1000));
}

/**
 * Parse a GLM Coding Plan usage-limit error, returning the reset details or
 * `null` when the error is not a GLM Coding Plan quota exhaustion. Mirrors
 * {@link parseChatGptSubscriptionLimit}: pure body inspection, no clock reads.
 */
export function parseGlmCodingPlanLimit(
  rawErrorBody: unknown,
): GlmCodingPlanLimit | null {
  for (const candidate of errorBodyCandidates(rawErrorBody)) {
    const code = pickStringField(candidate, 'code');
    if (!code || !GLM_CODING_PLAN_EXHAUSTION_CODES.has(code)) continue;
    const resetsInSeconds =
      pickNumberField(candidate, 'resets_in_seconds') ??
      secondsUntilReset(pickStringField(candidate, 'message') ?? '');
    return { resetsInSeconds };
  }
  return null;
}

/**
 * Whether a GLM Coding Plan error is a transient rate limit / overload (codes
 * 1302/1305) rather than quota exhaustion. These are retryable after a pause —
 * they are deliberately NOT classified as a coding-plan exhaustion, so the
 * retry UI keeps the ordinary retry affordance instead of the switch-to-regular
 * endpoint one.
 */
export function isGlmCodingPlanRateLimit(rawErrorBody: unknown): boolean {
  return errorBodyCandidates(rawErrorBody).some((candidate) => {
    const code = pickStringField(candidate, 'code');
    return code !== undefined && GLM_CODING_PLAN_RATE_LIMIT_CODES.has(code);
  });
}

/**
 * Human-readable message for a GLM Coding Plan rate-limit / overload error:
 * a clear "retry in a moment" hint distinct from quota exhaustion.
 */
export function describeGlmCodingPlanRateLimit(): string {
  return (
    'GLM Coding Plan rate limit reached. Wait a moment and retry; the plan is ' +
    'still active.'
  );
}

/**
 * Format a coarse "1d 20h" / "20h 22m" / "5m" duration from a second count,
 * matching {@link describeChatGptSubscriptionLimit}. Pure (no clock read), so
 * it stays usable from the synchronous error formatter.
 */
function formatResetDuration(totalSeconds: number): string {
  const wholeMinutes = Math.floor(Math.max(0, totalSeconds) / 60);
  if (wholeMinutes === 0) return 'less than a minute';
  const flooredMinutes =
    wholeMinutes >= 1440 ? wholeMinutes - (wholeMinutes % 60) : wholeMinutes;
  return prettyMilliseconds(flooredMinutes * 60_000, { unitCount: 2 });
}

/**
 * Human-readable message for a GLM Coding Plan usage-limit error: how long
 * until the quota resets (when reported) and the actionable next step.
 */
export function describeGlmCodingPlanLimit(info: GlmCodingPlanLimit): string {
  const reset =
    info.resetsInSeconds !== undefined
      ? ` Resets in ${formatResetDuration(info.resetsInSeconds)}.`
      : '';
  return (
    `GLM Coding Plan usage limit reached.${reset}` +
    ' Switch to the regular GLM endpoint to keep working, or wait until the limit resets.'
  );
}
