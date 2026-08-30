/**
 * Browser-safe diagnostic sink for browser-reachable, VS Code-free code.
 *
 * `@logger/logUtils` is the repo's real logging subsystem, but it is
 * Node-oriented — it pulls in `safe-stable-stringify`, secret redaction, and
 * `@utils/config/configUtils` — so a module that ships inside a webview bundle
 * (`@shared/schemas/*`, `@shared/state/*`, `@shared/wa/*`, `BaseWebviewApp`)
 * cannot call it. Those modules used to reach for bare `console.warn` /
 * `console.error` one site at a time, leaving diagnostics from the browser
 * side with no owner at all.
 *
 * This module is that owner: the single place browser-reachable code writes a
 * diagnostic, and the single place a host-supplied sink, level gate, or
 * redaction pass would be added if one is ever needed. It deliberately has no
 * imports and no injection seam — it is a sink, not a framework.
 *
 * Convention: prefix the message with a bracketed scope (`[roundIndexed] …`,
 * `[PersistedState] …`) so a warning in a shared module names its origin. Pass
 * an `Error` or a structured detail object as a trailing argument rather than
 * interpolating it, exactly as with `console.warn`.
 */

/** Report a recoverable problem: a salvaged parse, a fallback, a degraded read. */
export function logWarn(message: string, ...details: unknown[]): void {
  console.warn(message, ...details);
}

/** Report a failure that a caller could not recover from. */
export function logError(message: string, ...details: unknown[]): void {
  console.error(message, ...details);
}
