/**
 * Default tool timeouts shared between the tool implementations and the host
 * UIs that display a running-tool countdown (extension/desktop progress view).
 * Keep these here — not re-declared per host — so the displayed limit always
 * matches what the tool actually enforces.
 */

/** Default `bash` tool timeout (ms) when the model omits `timeout`. */
export const BASH_TOOL_DEFAULT_TIMEOUT_MS = 120_000;

/** Default `executions wait` timeout (seconds) when the model omits `timeout`. */
export const EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS = 300;

/** Maximum `executions wait` timeout (seconds). */
export const EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS = 1800;
