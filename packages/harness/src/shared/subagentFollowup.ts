// Host-neutral presentation of a child run's delivery to its parent.
//
// A delivery travels typed (`ChildRunDelivery`, on its parent's
// `followup.queued` row): every surface shows its summary, read from those
// facts (`followUpDisplay`), and only its parent's model reads its envelope.
// A notice carries what surfaces show as its `displayText`, so no text is
// parsed back here. This module intentionally has NO host imports (no
// vscode, no Ink/React) so the browser-safe transcript entry can carry it.

import { DELIVERY_FAMILY } from '@shared/deliveryTags';
import type {
  ChildRunDelivery,
  FollowUpContent,
  ScriptDeliverySummary,
} from '@shared/schemas';
import { formatScriptTally, tallyTotal } from '@shared/transcript/scriptCall';
import {
  formatCompactDuration,
  formatCostUsd,
  formatResultCount,
  stripControlCharacters,
} from '@utils/text/stringUtils';

const RESULT_RESPONSE_PREVIEW_LINES = 12;
const RESULT_RESPONSE_PREVIEW_CHARS = 1400;

/** Truncate a result's response for display in a status line. */
function truncatedResultResponsePreview(response: string): string {
  const trimmed = response.trim();
  if (trimmed === '') return '';

  const lines = trimmed.split('\n');
  const lineLimited = lines.length > RESULT_RESPONSE_PREVIEW_LINES;
  let preview = lines.slice(0, RESULT_RESPONSE_PREVIEW_LINES).join('\n');
  const charLimited = preview.length > RESULT_RESPONSE_PREVIEW_CHARS;
  if (charLimited) {
    preview = preview.slice(0, RESULT_RESPONSE_PREVIEW_CHARS).trimEnd();
  }

  if (!lineLimited && !charLimited) return trimmed;

  // Count from what actually survives: when the character cap also fired, the
  // line cap alone understates how much is hidden.
  const hiddenLines = lines.length - preview.split('\n').length;
  const hidden =
    hiddenLines > 0 ? formatResultCount(hiddenLines, 'more line') : 'more text';
  return `${preview}\n… ${hidden}; open the subagent transcript for the full response`;
}

/** Collapse a script delivery's summary to its transcript lines. The
 *  tick is earned only by a run whose every call succeeded; a completed run
 *  with a failed, stopped, or unreached call says so in its marker too. */
function formatScriptDeliverySummary(summary: ScriptDeliverySummary): string {
  const { tally } = summary;
  const clean = tally.ok === tallyTotal(tally);
  let marker = '✗';
  if (summary.outcome === 'completed') marker = clean ? '✓' : '!';
  const facts = [
    `${formatResultCount(summary.sectionCount, 'section')}`,
    formatScriptTally(tally),
    formatCostUsd(summary.costUsd),
    formatCompactDuration(summary.durationMs),
  ];
  const fileLines = summary.files.map((file) => {
    const diffstat =
      file.added != null && file.removed != null
        ? ` (+${file.added} -${file.removed})`
        : '';
    return `  ${file.path}${diffstat}`;
  });
  return [
    `${marker} ${summary.name} ${summary.outcome} · ${facts.join(' · ')}`,
    ...(summary.outcome === 'failed' && summary.errorCause
      ? [truncatedResultResponsePreview(summary.errorCause)]
      : []),
    ...fileLines,
  ].join('\n');
}

/**
 * A delivery collapsed to a one-line (or, for a result, status + response)
 * summary of its facts: a script's its summary's lines; a background
 * command's its description, else its command, and how it ended; any
 * other's its agent, else its family, with the start of its answer or its
 * failure.
 */
function deliverySummary(delivery: ChildRunDelivery): string {
  if (delivery.summary !== undefined)
    return formatScriptDeliverySummary(delivery.summary);
  const attribute = (name: string): string | undefined => {
    const value = delivery.attributes?.find(
      (attr) => attr.name === name,
    )?.value;
    return value == null ? undefined : String(value);
  };
  const { exit, message, wallTime } = delivery;

  // A background shell command (bashDelivery.ts) is named by the model's
  // description, else its command, and judged by its exit: it carries
  // neither `agent` nor `status`.
  if (delivery.family === DELIVERY_FAMILY.background) {
    // Model-written text reaches terminals: drop control characters so a
    // crafted description or command cannot emit escape sequences.
    const label = (name: string) =>
      stripControlCharacters(
        (attribute(name) ?? '').split('\n')[0] ?? '',
      ).trim();
    const failed =
      message !== undefined || (exit !== undefined && exit.code !== 0);
    // A timeout or a lost exit status has no code; name which.
    let outcome: string | undefined;
    if (exit?.timedOut) outcome = 'timed out';
    else if (exit?.code === null) outcome = 'no exit code';
    else if (exit !== undefined) outcome = `exit ${exit.code}`;
    const head = [
      `${failed ? '✗' : '✓'} ${label('description') || `$ ${label('command') || 'background command'}`}`,
      ...(failed && outcome !== undefined ? [outcome] : []),
      ...(message === undefined ? [] : ['failed']),
      wallTime,
    ]
      .filter(Boolean)
      .join(' · ');
    return message ? `${head}\n${stripControlCharacters(message, ' ')}` : head;
  }

  // Results and errors share one shape across families (`formatDelivery`);
  // one without an `agent` attribute is named by its family.
  const name = attribute('agent') ?? delivery.family;
  const wall = wallTime ? ` · ${wallTime}` : '';
  if (message === undefined) {
    const head = `✓ ${name} ${attribute('status') ?? 'completed'}${wall}`;
    const preview = truncatedResultResponsePreview(
      delivery.output?.response ?? delivery.response ?? '',
    );
    return preview ? `${head}\n${preview}` : head;
  }
  const head = `✗ ${name} failed${wall}`;
  return message ? `${head}\n${message}` : head;
}

interface FollowUpDisplay {
  readonly text: string;
  /** A script delivery's facts, typed beside its summary. */
  readonly scriptSummary?: ScriptDeliverySummary;
}

/** A follow-up as every surface shows it: a child's delivery as the summary
 *  of its facts, a script's with its summary typed beside it, so no
 *  renderer reads it from text; a message as its `displayText`, else its
 *  text. */
export function followUpDisplay(content: FollowUpContent): FollowUpDisplay {
  if (!('delivery' in content))
    return { text: content.displayText ?? content.text };
  const { delivery } = content;
  const text = deliverySummary(delivery);
  return delivery.summary === undefined
    ? { text }
    : { text, scriptSummary: delivery.summary };
}
