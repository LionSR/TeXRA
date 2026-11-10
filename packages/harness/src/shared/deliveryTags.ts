// The child-run delivery-envelope XML root tags (`<subagent-result>`,
// `<background-error>`, a plugin's `<…-result>`, …): a delivery names its
// family, and its envelope is `<family>-result`, or `<family>-error` for
// one that carries a failure (`formatDelivery`).
//
// The harness names only the families its own child runs deliver in. A
// plugin's tag is recognized by its shape, so a plugin declares nothing here
// and the harness names no plugin: a result or an error is `<family>-result`
// / `<family>-error` (an XML-entity-escaped body, opening with the `id`
// attribute `formatDelivery` writes first), and an activity report is a bare
// `<family>-activity>` ending its line (LF or CRLF), whose body the plugin
// neutralizes instead of escaping.
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

/** A regex alternation matching every delivery tag name, harness-minted or a
 *  plugin's; a plugin's carries the lookahead its shape requires. */
export const DELIVERY_TAG_PATTERN = [
  `(?:${Object.values(DELIVERY_FAMILY).join('|')})-(?:result|error)`,
  `${DELIVERY_FAMILY_PATTERN}-(?:result|error)(?= id=")`,
  `${DELIVERY_FAMILY_PATTERN}-activity(?=>\r?\n)`,
].join('|');
