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

/** Every recognized child-run delivery-envelope tag, in no particular order. */
export const DELIVERY_TAGS: readonly DeliveryTagEntry[] = [
  { tag: DELIVERY_TAG.subagentProgress, escaped: true },
  { tag: DELIVERY_TAG.subagentResult, escaped: true },
  { tag: DELIVERY_TAG.subagentError, escaped: true },
  { tag: DELIVERY_TAG.backgroundResult, escaped: true },
  { tag: DELIVERY_TAG.backgroundError, escaped: true },
  { tag: DELIVERY_TAG.codexResult, escaped: true },
  { tag: DELIVERY_TAG.codexError, escaped: true },
  { tag: DELIVERY_TAG.claudeAgentResult, escaped: true },
  { tag: DELIVERY_TAG.claudeAgentError, escaped: true },
  { tag: DELIVERY_TAG.workflowScriptResult, escaped: true },
  { tag: DELIVERY_TAG.workflowScriptError, escaped: true },
  { tag: DELIVERY_TAG.githubWebhookActivity, escaped: false },
  { tag: DELIVERY_TAG.executionActivity, escaped: false },
];
