/**
 * Whether an HTTP status code is transient (worth retrying): 408 request
 * timeout, 429 rate limit, or 5xx server error. Other 4xx statuses are
 * permanent and won't change on retry.
 *
 * Lives in `utils` (rather than `tools`, where the only current consumer of
 * this policy used to live) so both `src/tools` and `src/latex` can share it
 * without adding a `latex -> tools` subsystem edge on top of the existing
 * `tools -> latex` edge.
 */
export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
