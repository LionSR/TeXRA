// Host-neutral presentation of a child run's delivery to its parent, and of
// the delivery-envelope XML blocks whose tag vocabulary @shared/deliveryTags
// owns (`DELIVERY_TAG_PATTERN`).
//
// A delivery travels typed (`ChildRunDelivery`, on its parent's
// `followup.queued` row): every surface shows its summary, read from those
// facts (`followUpDisplay`), and only its parent's model reads its envelope.
// The XML is read here only where text carries an envelope: a host's notice
// (an activity report) and an envelope a model echoes inside its own
// streamed answer, collapsed to the same summary. This module intentionally
// has NO host imports (no vscode, no Ink/React) so the browser-safe
// transcript entry can carry it.

import { DELIVERY_FAMILY, DELIVERY_TAG_PATTERN } from '@shared/deliveryTags';
import type {
  ChildRunDelivery,
  FollowUpContent,
  ScriptDeliverySummary,
} from '@shared/schemas';
import { formatScriptTally } from '@shared/transcript/scriptCall';
import {
  formatCompactDuration,
  formatCostUsd,
  formatResultCount,
  stripControlCharacters,
} from '@utils/text/stringUtils';

// Every recognizer below is derived from the one owned pattern
// (@shared/deliveryTags), so a new child-run kind can never leak as raw XML
// into the CLI transcript or the queued follow-ups panel.
//
// `\b` after the alternation is NOT a safe tag-name terminator here: `-` is a
// non-word character, so `\b` also matches between `t` and `-` inside e.g.
// `script-result-partial`, letting a hyphen-extended tag prefix-match an
// existing one. Every producer (`formatDelivery`, a plugin's activity
// wrapper) only ever follows a tag name with whitespace
// (attributes), `>` (a bare open, as an activity report's), or the exact `/>`
// self-closing delimiter, so anchor on those delimiters instead of accepting
// any slash continuation.
const TAG_NAME_END = '(?=[\\s>]|/>)';
const DELIVERY_TAG_RE = new RegExp(
  `^<(${DELIVERY_TAG_PATTERN})${TAG_NAME_END}`,
);
// Embedded-block variants of the same recognizer, for delivery-envelope
// blocks that appear mid-stream inside assistant-role text rather than as a
// standalone follow-up message (see findIncompleteEmbeddedSubagentFollowup /
// summarizeEmbeddedSubagentFollowups below).
const EMBEDDED_DELIVERY_BLOCK_RE = new RegExp(
  `<(?:${DELIVERY_TAG_PATTERN})${TAG_NAME_END}[^>]*/>|<(${DELIVERY_TAG_PATTERN})${TAG_NAME_END}[^>]*>[\\s\\S]*?</\\1>`,
  'g',
);
const EMBEDDED_DELIVERY_OPEN_RE = new RegExp(
  `<(${DELIVERY_TAG_PATTERN})${TAG_NAME_END}[^>]*(?:/>|>)`,
  'g',
);
const EMBEDDED_DELIVERY_TAG_RE = new RegExp(
  `<(?:${DELIVERY_TAG_PATTERN})${TAG_NAME_END}`,
);
/** An envelope's opening tag's attributes (a value never holds `"`), and
 *  each of them. */
const OPEN_TAG_RE = /^<[\w-]+((?:\s+[\w-]+="[^"]*")*)/;
const ATTRIBUTE_RE = /([\w-]+)="([^"]*)"/g;
const RESULT_RESPONSE_PREVIEW_LINES = 12;
const RESULT_RESPONSE_PREVIEW_CHARS = 1400;

/**
 * The delivery-envelope tag `text` opens with, or undefined when the text is
 * not one of these blocks. The single recognizer for "is this a child-run
 * delivery envelope". Leading whitespace is allowed because producers hand
 * blocks over untrimmed.
 */
function deliveryTagOf(text: string): string | undefined {
  return DELIVERY_TAG_RE.exec(text.trim())?.[1];
}

function innerTag(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1]?.trim();
}

function elementBody(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`)
    .exec(xml)?.[1]
    ?.trim();
}

// An envelope's bodies and attributes are escaped by its producer; decode
// for display. `&amp;` last so an escaped `&lt;` never double-decodes.
export function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

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
  const clean = tally.ok === tally.total;
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
    // A timeout or a lost exit status has only a conventional code; name it.
    let outcome: string | undefined;
    if (exit?.timedOut) outcome = 'timed out';
    else if (exit?.noExitCode) outcome = 'no exit code';
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
  const retryable = attribute('retryable') === 'true';
  const head = `✗ ${name} failed${wall}${retryable ? ' (retryable)' : ''}`;
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

/**
 * The facts of a delivery envelope found in text, read back as
 * `formatDelivery` wrote them: its family, its attributes, and the elements
 * a summary reads. A stored delivery is typed; only a model's echo of one
 * comes as text.
 */
function echoedDelivery(xml: string, tag: string): ChildRunDelivery {
  const attributes = [
    ...(OPEN_TAG_RE.exec(xml)?.[1] ?? '').matchAll(ATTRIBUTE_RE),
  ].map(([, name = '', value = '']) => ({
    name,
    value: decodeXmlEntities(value),
  }));
  const element = (name: string): string | undefined => {
    const body = innerTag(xml, name);
    return body === undefined ? undefined : decodeXmlEntities(body);
  };
  const code = innerTag(xml, 'exit-code');
  return {
    family: tag.slice(0, tag.lastIndexOf('-')),
    runId: attributes.find(({ name }) => name === 'id')?.value ?? '',
    attributes,
    ...(code !== undefined && {
      exit: {
        code: Number(code),
        timedOut: innerTag(xml, 'timed-out') !== undefined,
        noExitCode: innerTag(xml, 'no-exit-code') !== undefined,
      },
    }),
    wallTime: innerTag(xml, 'wall-time'),
    response: element('response'),
    ...(tag.endsWith('-error') && { message: element('message') ?? '' }),
  };
}

/**
 * The envelope `text` is, collapsed: an activity report to its first line, a
 * delivery to the summary a stored one shows; any other text unchanged. For
 * the text that carries one: a host's notice, and an envelope a model
 * echoes.
 */
export function summarizeSubagentFollowup(text: string): string {
  const trimmed = text.trim();
  const tag = deliveryTagOf(trimmed);
  if (tag === undefined) return text;
  if (tag.endsWith('-activity')) {
    // An activity envelope (`<family>-activity`) wraps a plain sanitized
    // text body with no attribute schema: its first line.
    const firstLine = elementBody(trimmed, tag)?.split('\n')[0]?.trim();
    return firstLine || text;
  }
  return deliverySummary(echoedDelivery(trimmed, tag));
}

type IncompleteEmbeddedSubagentFollowup = {
  readonly index: number;
  readonly block: string;
};

function findIncompleteEmbeddedSubagentFollowup(
  text: string,
): IncompleteEmbeddedSubagentFollowup | undefined {
  for (const match of text.matchAll(EMBEDDED_DELIVERY_OPEN_RE)) {
    const index = match.index;
    const tag = match[1];
    const opening = match[0];
    if (opening.endsWith('/>')) continue;

    const closing = new RegExp(`</${tag}>`, 'g');
    closing.lastIndex = index + opening.length;
    if (!closing.exec(text)) {
      return { index, block: text.slice(index) };
    }
  }
  return undefined;
}

export function hasIncompleteEmbeddedSubagentFollowup(text: string): boolean {
  return (
    EMBEDDED_DELIVERY_TAG_RE.test(text) &&
    findIncompleteEmbeddedSubagentFollowup(text) !== undefined
  );
}

export function summarizeEmbeddedSubagentFollowups(text: string): string {
  if (!EMBEDDED_DELIVERY_TAG_RE.test(text)) return text;
  const completeSummarized = text.replaceAll(
    EMBEDDED_DELIVERY_BLOCK_RE,
    (block) => summarizeSubagentFollowup(block),
  );
  const incomplete = findIncompleteEmbeddedSubagentFollowup(completeSummarized);
  if (!incomplete) return completeSummarized;
  return `${completeSummarized.slice(0, incomplete.index)}${summarizeSubagentFollowup(incomplete.block)}`;
}
