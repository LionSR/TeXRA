/**
 * Shared XML envelope formatting for child-run deliveries — the one
 * result/error builder for every child path: native subagents
 * (`formatSubagentDelivery`/`formatSubagentError` in subagentResults.ts),
 * background bash (bashDelivery.ts), workflow scripts
 * (workflowScriptStrategy.ts) and the agent-CLI tools (codex.ts,
 * claudeAgent.ts).
 *
 * The child drivers decide what facts belong in the payload; callers differ
 * only in tag, id attributes, and the facts they pass. This module owns the
 * repetitive boundary mechanics: ordered attributes, XML escaping,
 * opening/closing tags, and the shared body elements (wall-time, response,
 * usage, caller lines, message). A result and an error are the same envelope
 * over different facts — an error is the one that carries `message` — so
 * there is one builder rather than a result/error pair whose bodies drift.
 */

// Local imports
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';

interface DeliveryEnvelopeAttribute {
  readonly name: string;
  readonly value: string | number | boolean | null | undefined;
}

/** Maximum prompt length echoed back in a delivery/error XML attribute. */
const DELIVERY_PROMPT_MAX = 200;

/**
 * One child-run delivery: the envelope's identity followed by the facts its
 * driver selected. Every fact is optional; the body renders those present, in
 * the fixed order declared below, so two drivers reporting the same fact
 * always render it the same way and in the same place.
 */
interface ChildRunDelivery {
  /** Root element name (`subagent-result`, `codex-error`, …). */
  readonly tag: string;
  readonly runId: string;
  /** Echoed prompt attribute (agent-CLI deliveries); truncated before escaping. */
  readonly prompt?: string;
  /**
   * Attributes rendered after id/prompt (`agent`, `status`, `thread-id`, …).
   * Null/undefined values are dropped by the envelope.
   */
  readonly attributes?: readonly DeliveryEnvelopeAttribute[];
  /** Pre-rendered wall-time body text (`1.2s` agent-CLI, `formatDuration` native). */
  readonly wallTime?: string;
  /** Final assistant response as one inline element; empty → `(no response)`. */
  readonly response?: string;
  /** Token usage element; omitted when null/undefined. */
  readonly usage?: { input: number; output: number } | null;
  /** Pre-rendered fact lines appended after the shared elements. */
  readonly lines?: readonly string[];
  /** Failure text; its presence is what makes this delivery an error report. */
  readonly message?: string;
}

/**
 * Renames an SDK/provider usage shape (`input_tokens`/`output_tokens`,
 * optional across providers) into {@link ChildRunDelivery.usage}'s
 * `{input, output}` shape, defaulting missing counts to 0. Single source for
 * a mapping every child-run driver otherwise re-derives per provider.
 */
export function toDeliveryUsage(
  usage: { input_tokens?: number; output_tokens?: number } | null | undefined,
): { input: number; output: number } | null {
  return usage
    ? { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 }
    : null;
}

/**
 * Build the `<...-result>` / `<...-error>` XML delivered to the parent's
 * follow-up queue when a child run's turn settles.
 */
export function formatDelivery(delivery: ChildRunDelivery): string {
  const attributes: readonly DeliveryEnvelopeAttribute[] = [
    { name: 'id', value: delivery.runId },
    ...(delivery.prompt !== undefined
      ? [
          {
            name: 'prompt',
            value: delivery.prompt.slice(0, DELIVERY_PROMPT_MAX),
          },
        ]
      : []),
    ...(delivery.attributes ?? []),
  ];
  const attrs = attributes
    .filter((attr) => attr.value != null)
    .map((attr) => `${attr.name}="${escapeAttr(String(attr.value))}"`)
    .join(' ');

  const body: string[] = [];
  if (delivery.wallTime !== undefined) {
    body.push(`<wall-time>${delivery.wallTime}</wall-time>`);
  }
  if (delivery.response !== undefined) {
    body.push(
      `<response>${escapeText(delivery.response || '(no response)')}</response>`,
    );
  }
  if (delivery.usage) {
    body.push(
      `<usage input="${delivery.usage.input}" output="${delivery.usage.output}" />`,
    );
  }
  if (delivery.lines) body.push(...delivery.lines);
  if (delivery.message !== undefined) {
    body.push(`<message>${escapeText(delivery.message)}</message>`);
  }

  const open = attrs ? `<${delivery.tag} ${attrs}>` : `<${delivery.tag}>`;
  return [open, ...body, `</${delivery.tag}>`].join('\n');
}
