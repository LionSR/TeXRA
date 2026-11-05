// Host-neutral parsing/formatting for the child-run delivery-envelope XML
// blocks whose tag vocabulary @shared/deliveryTags owns
// (`DELIVERY_TAG_PATTERN`).
// These blocks are queued follow-up messages addressed to the orchestrator
// *model*, injected into the conversation as user turns.
//
// A delivery or notice envelope is collapsed to a terse status line
// (summarizeSubagentFollowup) once, when its recipient queues it, and stored as
// the follow-up's `displayText`, which every surface shows. This module is
// the single source of truth for the block parsing and entity decoding. It
// intentionally has NO host imports (no vscode, no Ink/React) so the
// browser-safe transcript entry can carry it.

import escapeRegExp from 'escape-string-regexp';
import { Result, Schema } from 'effect';
import { DELIVERY_TAG, DELIVERY_TAG_PATTERN } from '@shared/deliveryTags';
import type { ScriptDeliverySummary } from '@shared/schemas';
import { ScriptDeliverySummarySchema } from '@shared/schemas';
import { escapeText } from '@shared/utils/xmlEscape';
import { formatScriptTally } from '@shared/transcript/workflowCall';
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
const EMPTY_FOLLOW_UP_SUMMARY = '(empty follow-up)';
const RESULT_RESPONSE_PREVIEW_LINES = 12;
const RESULT_RESPONSE_PREVIEW_CHARS = 1400;

/**
 * The delivery-envelope tag `text` opens with, or undefined when the text is
 * not one of these blocks. The single recognizer for "is this a child-run
 * delivery envelope". Leading whitespace is allowed because producers hand
 * blocks over untrimmed.
 */
export function deliveryTagOf(text: string): string | undefined {
  return DELIVERY_TAG_RE.exec(text.trim())?.[1];
}

function followupText(text: unknown): string | undefined {
  return typeof text === 'string' ? text : undefined;
}

function attr(xml: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${escapeRegExp(name)}="([^"]*)"`).exec(xml)?.[1];
}

function innerTag(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1]?.trim();
}

function elementBody(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`)
    .exec(xml)?.[1]
    ?.trim();
}

// `<message>` bodies are escapeText()'d by the producer; decode for display.
// `&amp;` last so an escaped `&lt;` never double-decodes.
export function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/** Truncate an already-decoded result response for display in a status line. */
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

/** The envelopes that carry a `<script-summary>` element; every other tag's
 *  body is entity-escaped, so the element cannot appear in it. */
const SUMMARIZED_TAGS: ReadonlySet<string> = new Set([
  DELIVERY_TAG.scriptResult,
  DELIVERY_TAG.scriptError,
]);

/**
 * Read the presentation-only facts attached to a workflow delivery, or
 * undefined for text that is not a script envelope carrying them. The raw
 * response remains intact for the invoking model and diagnostic inspection.
 * This string parse lives at the delivery boundary (the queued row's
 * `displayText` and the transcript row's typed summary), never at render
 * time: renderers receive the parsed summary carried beside the row text.
 */
export function parseScriptDeliverySummary(
  xml: string,
): ScriptDeliverySummary | undefined {
  const tag = deliveryTagOf(xml);
  if (tag === undefined || !SUMMARIZED_TAGS.has(tag)) return undefined;
  const rawSummary = innerTag(xml, 'script-summary');
  if (!rawSummary) return undefined;
  return Result.getOrUndefined(
    Schema.decodeUnknownResult(
      Schema.fromJsonString(ScriptDeliverySummarySchema),
    )(decodeXmlEntities(rawSummary)),
  );
}

/** Collapse a parsed workflow delivery summary to its transcript lines. The
 *  tick is earned only by a run whose every call succeeded; a completed run
 *  with a failed, stopped, or unreached call says so in its marker too. */
function formatScriptDeliverySummary(summary: ScriptDeliverySummary): string {
  const { tally } = summary;
  const clean = tally.ok === tally.total;
  let marker = '✗';
  if (summary.outcome === 'completed') marker = clean ? '✓' : '!';
  const facts = [
    `${formatResultCount(summary.phaseCount, 'phase')}`,
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

/** The `<script-summary>` element a script's delivery carries, which
 *  {@link parseScriptDeliverySummary} reads back. */
export function scriptSummaryElement(summary: ScriptDeliverySummary): string {
  return `<script-summary>${escapeText(JSON.stringify(summary))}</script-summary>`;
}

/**
 * What a child-run delivery says, without its envelope: a result's
 * `<response>` or an error's `<message>`, decoded, else the envelope's
 * one-line summary (`summarizeSubagentFollowup`), as for a task's
 * result that lists only its files. Undefined for any text that is not a
 * result or error envelope. The one reading every surface uses to show an
 * `agent` call's answer, so no host prints the delivery XML.
 */
export function deliveredResponse(text: string): string | undefined {
  const trimmed = text.trim();
  const tag = deliveryTagOf(trimmed);
  if (tag === undefined) return undefined;
  let body: string | undefined;
  if (tag.endsWith('-result')) body = innerTag(trimmed, 'response');
  else if (tag.endsWith('-error')) body = innerTag(trimmed, 'message');
  else return undefined;
  return body ? decodeXmlEntities(body) : summarizeSubagentFollowup(trimmed);
}

/**
 * Collapse a subagent follow-up XML block into a one-line (or, for results,
 * status + response) human-readable summary. Returns `text` unchanged when it
 * is not a subagent block. Malformed non-string payloads render as a visible
 * placeholder instead of crashing status surfaces.
 */
export function summarizeSubagentFollowup(text: unknown): string {
  const normalized = followupText(text);
  if (normalized === undefined) return EMPTY_FOLLOW_UP_SUMMARY;

  const trimmed = normalized.trim();
  const tag = deliveryTagOf(trimmed);
  if (!tag) return normalized;

  const summary = parseScriptDeliverySummary(trimmed);
  if (summary) return formatScriptDeliverySummary(summary);

  // A background shell command (bashDelivery.ts) is named by the model's
  // description, else its command, and judged by its exit code: it carries
  // neither `agent` nor `status`.
  if (
    tag === DELIVERY_TAG.backgroundResult ||
    tag === DELIVERY_TAG.backgroundError
  ) {
    // Model-written text reaches terminals: drop control characters so a
    // crafted description or command cannot emit escape sequences.
    const label = (name: string) =>
      stripControlCharacters(
        decodeXmlEntities(attr(trimmed, name) ?? '').split('\n')[0] ?? '',
      ).trim();
    const description = label('description');
    const command = label('command');
    const exitCode = innerTag(trimmed, 'exit-code');
    const failed =
      tag === DELIVERY_TAG.backgroundError ||
      (exitCode !== undefined && exitCode !== '0');
    const message = innerTag(trimmed, 'message');
    // A timeout or a lost exit status has only a synthetic code; name it.
    let outcome: string | undefined;
    if (innerTag(trimmed, 'timed-out') !== undefined) outcome = 'timed out';
    else if (innerTag(trimmed, 'no-exit-code') !== undefined)
      outcome = 'no exit code';
    else if (exitCode !== undefined) outcome = `exit ${exitCode}`;
    const facts = [
      `${failed ? '✗' : '✓'} ${description || `$ ${command || 'background command'}`}`,
      ...(failed && outcome !== undefined ? [outcome] : []),
      ...(tag === DELIVERY_TAG.backgroundError ? ['failed'] : []),
      innerTag(trimmed, 'wall-time'),
    ].filter(Boolean);
    const head = facts.join(' · ');
    return message
      ? `${head}\n${stripControlCharacters(decodeXmlEntities(message), ' ')}`
      : head;
  }

  // Result/error envelopes share one shape across families
  // (deliveryEnvelope.ts's `formatDelivery`); one without an `agent`
  // attribute is named by its family.
  if (tag.endsWith('-result')) {
    const agent = attr(trimmed, 'agent') ?? tag.slice(0, -'-result'.length);
    const status = attr(trimmed, 'status') ?? 'completed';
    const wall = innerTag(trimmed, 'wall-time');
    const response = innerTag(trimmed, 'response');
    const head = `✓ ${agent} ${status}${wall ? ` · ${wall}` : ''}`;
    const preview = response
      ? truncatedResultResponsePreview(decodeXmlEntities(response))
      : '';
    return preview ? `${head}\n${preview}` : head;
  }

  if (tag.endsWith('-error')) {
    const agent = attr(trimmed, 'agent') ?? tag.slice(0, -'-error'.length);
    const wall = innerTag(trimmed, 'wall-time');
    const message = innerTag(trimmed, 'message');
    const retryable = attr(trimmed, 'retryable') === 'true';
    const head = `✗ ${agent} failed${wall ? ` · ${wall}` : ''}${retryable ? ' (retryable)' : ''}`;
    return message ? `${head}\n${decodeXmlEntities(message)}` : head;
  }

  // Activity envelopes (`<family>-activity`) wrap a plain sanitized text
  // body with no attribute schema, so surface its first line instead of the
  // raw wrapper tags.
  const body = elementBody(trimmed, tag);
  const firstLine = body?.split('\n')[0]?.trim();
  return firstLine || normalized;
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
