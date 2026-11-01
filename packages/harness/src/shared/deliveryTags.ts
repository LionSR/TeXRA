// The child-run delivery-envelope XML root tags (`<subagent-result>`,
// `<background-error>`, a plugin's `<…-result>`, …) that producers mint and
// render surfaces (progressView UserMessage, the CLI transcript) recognize.
//
// The harness names only the tags its own child runs mint. A plugin's tag is
// recognized by its shape, so a plugin declares nothing here and the harness
// names no plugin: a result or an error it builds with `formatDelivery` is
// `<family>-result` / `<family>-error` (an XML-entity-escaped body, opening
// with the `id` attribute that builder writes first), and an activity report
// is a bare `<family>-activity>` ending its line, whose body the plugin
// neutralizes instead of escaping. `family` is lowercase words joined by `-`.
//
// Intentionally has NO host imports (no vscode, no Ink/React) so both
// @shared (webview) and the CLI can consume it, matching subagentFollowup.ts.

/** The tags the harness's own child runs mint, referenced by its producers
 *  instead of string literals. */
export const DELIVERY_TAG = {
  subagentProgress: 'subagent-progress',
  subagentResult: 'subagent-result',
  subagentError: 'subagent-error',
  backgroundResult: 'background-result',
  backgroundError: 'background-error',
  scriptResult: 'script-result',
  scriptError: 'script-error',
  childPaused: 'child-paused',
} as const;

const FAMILY = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';

/** A regex alternation matching every delivery tag name, harness-minted or a
 *  plugin's; a plugin's carries the lookahead its shape requires. */
export const DELIVERY_TAG_PATTERN = [
  ...Object.values(DELIVERY_TAG),
  `${FAMILY}-(?:result|error)(?= id=")`,
  `${FAMILY}-activity(?=>\n)`,
].join('|');

/**
 * Whether the envelope body is XML-entity-escaped (via `escapeText()` in
 * the producer) and needs `decodeXmlEntities()` before display. An activity
 * report (a plugin's bare `<family>-activity>` open on its own line)
 * neutralizes
 * embedded tag names rather than escaping, so it is the one kind that is
 * not.
 */
export function deliveryBodyEscaped(tag: string): boolean {
  return !tag.endsWith('-activity');
}
