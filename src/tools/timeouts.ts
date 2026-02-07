/**
 * Centralized timeout constants for all tools.
 *
 * Keep all tool timeout durations here for easy tuning and consistent
 * error reporting.
 */

// ─── Bash ────────────────────────────────────────────────────────────────────

/** Bash tool: default command timeout (120 s). */
export const BASH_TIMEOUT_MS = 120_000;

// ─── Wolfram ─────────────────────────────────────────────────────────────────

/** Wolfram tool: inline code execution timeout (30 s). */
export const WOLFRAM_CODE_TIMEOUT_MS = 30_000;

/** Wolfram tool: script file execution timeout (60 s). */
export const WOLFRAM_FILE_TIMEOUT_MS = 60_000;

// ─── Web Fetch ───────────────────────────────────────────────────────────────

/** Web Fetch tool: HTTP request timeout (30 s). */
export const WEB_FETCH_TIMEOUT_MS = 30_000;

// ─── Loogle (Lean theorem search) ────────────────────────────────────────────

/** Loogle tool: API request timeout (10 s). */
export const LOOGLE_TIMEOUT_MS = 10_000;

// ─── Zotero ──────────────────────────────────────────────────────────────────

/** Zotero Better BibTeX: default JSON-RPC timeout (10 s). */
export const ZOTERO_BBT_TIMEOUT_MS = 10_000;

/** Zotero Better BibTeX: export operation timeout (30 s). */
export const ZOTERO_EXPORT_TIMEOUT_MS = 30_000;

/** Zotero Connector: ping / health-check timeout (2 s). */
export const ZOTERO_PING_TIMEOUT_MS = 2_000;

/** Zotero Connector: API call timeout (30 s). */
export const ZOTERO_CONNECTOR_TIMEOUT_MS = 30_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check whether an axios error code indicates a timeout.
 *
 * axios uses ECONNABORTED by default and ETIMEDOUT when
 * `clarifyTimeoutError` is enabled or via the fetch adapter.
 */
export function isTimeoutErrorCode(code: string | undefined): boolean {
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT';
}

/**
 * Build a consistent timeout error message.
 *
 * @example buildTimeoutMessage('Command execution', 120_000)
 * // → "Command execution timed out after 120s."
 */
export function buildTimeoutMessage(action: string, timeoutMs: number): string {
  return `${action} timed out after ${timeoutMs / 1000}s.`;
}
