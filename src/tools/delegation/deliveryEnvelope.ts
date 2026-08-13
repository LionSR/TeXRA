/**
 * Shared XML envelope formatting for child-run deliveries — the one
 * result/error builder family for every child path: native subagents
 * (`formatSubagentDelivery`/`formatSubagentError` in subagentResults.ts) and
 * the agent-CLI tools (codex.ts, claudeAgent.ts).
 *
 * The child drivers decide what facts belong in the payload; callers differ
 * only in tag, id attributes, and the facts they pass. This module owns the
 * repetitive boundary mechanics: ordered attributes, XML escaping,
 * opening/closing tags, and the shared body elements (wall-time, response,
 * usage, message).
 */

// Local imports
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';

interface DeliveryEnvelopeAttribute {
  readonly name: string;
  readonly value: string | number | boolean | null | undefined;
}

/** Maximum prompt length echoed back in a delivery/error XML attribute. */
const DELIVERY_PROMPT_MAX = 200;

interface ChildRunEnvelope {
  /** Root element name (`subagent-result`, `codex-result`, `claude-agent-error`, …). */
  readonly tag: string;
  readonly executionId: string;
  /** Echoed prompt attribute (agent-CLI deliveries); truncated before escaping. */
  readonly prompt?: string;
  /**
   * Attributes rendered after id/prompt (`agent`, `status`, `thread-id`, …).
   * Null/undefined values are dropped by the envelope.
   */
  readonly attributes?: readonly DeliveryEnvelopeAttribute[];
}

function childRunEnvelopeXml(
  envelope: ChildRunEnvelope,
  bodyLines: readonly string[],
): string {
  const attributes: readonly DeliveryEnvelopeAttribute[] = [
    { name: 'id', value: envelope.executionId },
    ...(envelope.prompt !== undefined
      ? [
          {
            name: 'prompt',
            value: envelope.prompt.slice(0, DELIVERY_PROMPT_MAX),
          },
        ]
      : []),
    ...(envelope.attributes ?? []),
  ];
  const attrs = attributes
    .filter((attr) => attr.value != null)
    .map((attr) => `${attr.name}="${escapeAttr(String(attr.value))}"`)
    .join(' ');
  const open = attrs ? `<${envelope.tag} ${attrs}>` : `<${envelope.tag}>`;
  return [open, ...bodyLines, `</${envelope.tag}>`].join('\n');
}

interface ChildRunDeliveryFacts {
  /** Pre-rendered wall-time body text (`1.2s` agent-CLI, `formatDuration` native). */
  readonly wallTime?: string;
  /** Final assistant response as one inline element; empty → `(no response)`. */
  readonly response?: string;
  /** Token usage element; omitted when null/undefined. */
  readonly usage?: { input: number; output: number } | null;
  /** Pre-rendered fact lines appended before the closing tag. */
  readonly lines?: readonly string[];
}

/**
 * Build the `<...-result>` XML delivered to the parent's follow-up queue when
 * a child run's turn completes.
 */
export function formatChildRunDelivery(
  envelope: ChildRunEnvelope,
  facts: ChildRunDeliveryFacts,
): string {
  const bodyLines: string[] = [];
  if (facts.wallTime !== undefined) {
    bodyLines.push(`<wall-time>${facts.wallTime}</wall-time>`);
  }
  if (facts.response !== undefined) {
    bodyLines.push(
      `<response>${escapeText(facts.response || '(no response)')}</response>`,
    );
  }
  if (facts.usage) {
    bodyLines.push(
      `<usage input="${facts.usage.input}" output="${facts.usage.output}" />`,
    );
  }
  if (facts.lines) bodyLines.push(...facts.lines);
  return childRunEnvelopeXml(envelope, bodyLines);
}

/**
 * Build the `<...-error>` XML delivered when a child run's turn fails.
 */
export function formatChildRunError(
  envelope: ChildRunEnvelope,
  facts: {
    readonly wallTime?: string;
    readonly lines?: readonly string[];
    readonly message: string;
  },
): string {
  const bodyLines: string[] = [];
  if (facts.wallTime !== undefined) {
    bodyLines.push(`<wall-time>${facts.wallTime}</wall-time>`);
  }
  if (facts.lines) bodyLines.push(...facts.lines);
  bodyLines.push(`<message>${escapeText(facts.message)}</message>`);
  return childRunEnvelopeXml(envelope, bodyLines);
}
