/**
 * Whether an HTTP status code is transient (worth retrying): 408 request
 * timeout, 429 rate limit, or 5xx server error. Other 4xx statuses are
 * permanent and won't change on retry.
 *
 * This is the general-purpose HTTP policy (tool fetches, tool timeouts,
 * device-code polling). The llm package's internal provider-error retry
 * policy is a separate, deliberately different policy for LLM provider SDK
 * errors: it also treats 409 Conflict as retryable, because a provider API's
 * 409 usually signals a transient session/resource race, unlike a generic
 * HTTP 409. Don't merge the two without re-confirming that call for every
 * consumer.
 */
export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
