// A child run's delivery names its family, and its envelope is
// `<family>-result`, or `<family>-error` for one that carries a failure
// (`formatDelivery`). The harness names only the families its own child runs
// deliver in; a plugin's family is any name of the same shape.
//
// Intentionally has NO host imports (no vscode, no Ink/React) so both
// @shared (webview) and the CLI can consume it, matching subagentFollowup.ts.

/** The families the harness's own child runs deliver in, referenced by
 *  their producers instead of string literals. */
export const DELIVERY_FAMILY = {
  subagent: 'subagent',
  background: 'background',
  script: 'script',
} as const;

/** A delivery's family: lowercase words joined by `-`. */
export const DELIVERY_FAMILY_PATTERN = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
