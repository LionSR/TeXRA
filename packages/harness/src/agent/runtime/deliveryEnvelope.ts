/**
 * The one renderer of a child run's delivery as the XML envelope its
 * parent's model reads, for every child path: native subagents
 * (childDelivery.ts), background bash (bashDelivery.ts), background scripts
 * (scriptRun.ts) and a plugin's tools that run a child of their own (an
 * agent CLI's). A delivery travels typed (`ChildRunDelivery`, on its
 * parent's `followup.queued` row) and is rendered here where it becomes that
 * model's message, and as the child's stored report.
 *
 * The child drivers decide what facts belong in the payload; callers differ
 * only in family, attributes, and the facts they pass. This module owns the
 * repetitive boundary mechanics: ordered attributes, XML escaping,
 * opening/closing tags, and the shared body elements. A result and an error
 * are the same envelope over different facts — an error is the one that
 * carries `message` — so there is one renderer rather than a result/error
 * pair whose bodies drift.
 */

// Local imports
import type { ChildRunDelivery } from '@shared/schemas';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';

/** Maximum prompt length echoed back in a delivery/error XML attribute. */
const DELIVERY_PROMPT_MAX = 200;

/**
 * The `<family>-result` / `<family>-error` XML of a delivery: its id and
 * prompt, its attributes, then the facts present, in the fixed order its
 * schema declares, so two drivers reporting the same fact always render it
 * the same way and in the same place.
 */
export function formatDelivery(delivery: ChildRunDelivery): string {
  const tag = `${delivery.family}-${delivery.message === undefined ? 'result' : 'error'}`;
  const attrs = [
    { name: 'id', value: delivery.runId },
    { name: 'prompt', value: delivery.prompt?.slice(0, DELIVERY_PROMPT_MAX) },
    ...(delivery.attributes ?? []),
  ]
    .filter((attr) => attr.value != null)
    .map((attr) => `${attr.name}="${escapeAttr(String(attr.value))}"`)
    .join(' ');

  const { exit, output } = delivery;
  const body: string[] = [];
  if (exit !== undefined) {
    body.push(`<exit-code>${exit.code}</exit-code>`);
    // The code is a conventional one when the process timed out or its exit
    // status was lost; say which, so no reader takes it for a real exit.
    if (exit.timedOut) body.push('<timed-out>true</timed-out>');
    if (exit.noExitCode) body.push('<no-exit-code>true</no-exit-code>');
  }
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
      `<usage input="${delivery.usage.inputTokens}" output="${delivery.usage.outputTokens}" />`,
    );
  }
  if (delivery.summary !== undefined) {
    body.push(
      `<script-summary>${escapeText(JSON.stringify(delivery.summary))}</script-summary>`,
    );
  }
  if (delivery.lines) body.push(...delivery.lines);
  if (output !== undefined) {
    if (output.response) {
      body.push('<response>', escapeText(output.response), '</response>');
    }
    if (output.files.length > 0) {
      body.push(
        '<touched-files>',
        ...output.files.map((file) => `<file path="${escapeAttr(file)}" />`),
        '</touched-files>',
      );
    }
  }
  if (delivery.message !== undefined) {
    body.push(`<message>${escapeText(delivery.message)}</message>`);
  }

  return [`<${tag} ${attrs}>`, ...body, `</${tag}>`].join('\n');
}
