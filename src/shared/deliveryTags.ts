// Single source of truth for the child-run delivery-envelope XML root tags
// (`<subagent-result>`, `<codex-error>`, `<execution-activity>`, …) that
// producers (src/tools/*, src/agent/runtime/ExecutionSubscriptionBinder.ts)
// mint and render surfaces (progressView UserMessage, the CLI transcript)
// must recognize. Previously each render surface hand-listed the tag
// vocabulary separately from the producers, so a new child-run kind (e.g.
// `claude-agent-result`) could ship without ever being added to a render
// list and would render as raw XML. Adding a new child-run kind is now one
// entry here.
//
// Intentionally has NO host imports (no vscode, no Ink/React) so both
// @shared (webview) and the CLI can consume it, matching subagentFollowup.ts.

/** Canonical tag names, referenced by producers instead of string literals. */
export const DELIVERY_TAG = {
  subagentProgress: 'subagent-progress',
  subagentResult: 'subagent-result',
  subagentError: 'subagent-error',
  backgroundResult: 'background-result',
  backgroundError: 'background-error',
  codexResult: 'codex-result',
  codexError: 'codex-error',
  claudeAgentResult: 'claude-agent-result',
  claudeAgentError: 'claude-agent-error',
  workflowScriptResult: 'workflow-script-result',
  workflowScriptError: 'workflow-script-error',
  githubWebhookActivity: 'github-webhook-activity',
  executionActivity: 'execution-activity',
} as const;

/** Every canonical tag name — the union `DELIVERY_TAGS` entries must draw from. */
export type DeliveryTagName = (typeof DELIVERY_TAG)[keyof typeof DELIVERY_TAG];

export interface DeliveryTagEntry {
  readonly tag: DeliveryTagName;
  /**
   * Whether the envelope body is XML-entity-escaped (via `escapeText()` in
   * the producer) and needs `decodeXmlEntities()` before display.
   * `subagent-progress` is included because its "todos" variant runs todo
   * text through `escapeText()`, producing `&amp;`/`&lt;` entities in the
   * body. `github-webhook-activity` / `execution-activity` use
   * `wrapAndSanitizeTag()` instead, which neutralizes embedded tag names
   * rather than XML-entity-escaping, so they are not in the escaped subset.
   */
  readonly escaped: boolean;
}

/** The tags whose bodies are neutralized rather than XML-entity-escaped. */
const UNESCAPED_DELIVERY_TAGS = new Set<DeliveryTagName>([
  DELIVERY_TAG.githubWebhookActivity,
  DELIVERY_TAG.executionActivity,
]);

/** Every recognized child-run delivery-envelope tag, in no particular order. */
export const DELIVERY_TAGS: readonly DeliveryTagEntry[] = Object.values(
  DELIVERY_TAG,
).map((tag) => ({ tag, escaped: !UNESCAPED_DELIVERY_TAGS.has(tag) }));
