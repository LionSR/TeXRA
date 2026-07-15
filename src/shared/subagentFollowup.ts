// Host-neutral parsing/formatting for the child-run delivery-envelope XML
// blocks produced by src/tools/subagentResults.ts, codex.ts, claudeAgent.ts,
// github/formatUtils.ts, and ExecutionSubscriptionBinder.ts (the tags owned
// by @shared/deliveryTags: `<subagent-progress>`, `<subagent-result>`,
// `<subagent-error>`, `<background-result>`, `<background-error>`,
// `<codex-result>`, `<codex-error>`, `<claude-agent-result>`,
// `<claude-agent-error>`, `<github-webhook-activity>`,
// `<execution-activity>`). These blocks are FollowUpQueue messages addressed
// to the orchestrator *model*, injected into the conversation as user turns.
//
// Both hosts render them: the CLI transcript collapses each block to a terse
// status line (summarizeSubagentFollowup), and the extension ProgressView
// bubble decodes the entity-escaped body for markdown display. This module is
// the single source of truth for the block parsing, entity decoding, and
// progress-detail logic so the two surfaces never drift. It intentionally has
// NO host imports (no vscode, no Ink/React) so both @shared (webview) and the
// CLI can consume it.

import escapeRegExp from 'escape-string-regexp';
import { safeParseJson } from '@common/parsing/safeParseJson';
import { DELIVERY_TAG, DELIVERY_TAGS } from '@shared/deliveryTags';
import { formatResultCount } from '@utils/text/stringUtils';

// Derived from the single owned DELIVERY_TAGS list (@shared/deliveryTags),
// same derivation pattern UserMessage.ts uses for its structured-delivery
// recognizer — so a future child-run kind only needs one entry there. Before
// this, a bare `subagent-(?:progress|result|error)` recognizer let
// `claude-agent-result`/`claude-agent-error`/`codex-result`/`codex-error`
// leak as raw XML into the CLI transcript and queued follow-ups panel.
const DELIVERY_TAG_NAMES = DELIVERY_TAGS.map((entry) => entry.tag);
const DELIVERY_TAG_ALTERNATION = DELIVERY_TAG_NAMES.join('|');
// `\b` after the alternation is NOT a safe tag-name terminator here: `-` is a
// non-word character, so `\b` also matches between `t` and `-` inside e.g.
// `codex-result-partial`, letting a future hyphen-extended tag prefix-match
// an existing one (no current DELIVERY_TAGS entry is a prefix of another, but
// the vocabulary is a shared, growing const). Every producer
// (deliveryEnvelope.ts / subagentResults.ts / sanitizeTag.ts) only ever
// follows a tag name with whitespace (attributes), `>` (bare open, e.g.
// `<execution-activity>`), or the exact `/>` self-closing delimiter, so anchor
// on those delimiters instead of accepting any slash continuation.
const TAG_NAME_END = '(?=[\\s>]|/>)';
const SUBAGENT_TAG_RE = new RegExp(
  `^<(${DELIVERY_TAG_ALTERNATION})${TAG_NAME_END}`,
);
// Embedded-block variants of the same recognizer, for delivery-envelope
// blocks that appear mid-stream inside assistant-role text rather than as a
// standalone follow-up message (see findIncompleteEmbeddedSubagentFollowup /
// summarizeEmbeddedSubagentFollowups below). Previously hard-coded to
// `subagent-(?:progress|result|error)`, which let `codex-result`,
// `claude-agent-error`, and the rest of the non-`subagent-*` families leak as
// raw XML when embedded (issue #7846, follow-up to #7679/#7788).
const EMBEDDED_DELIVERY_BLOCK_RE = new RegExp(
  `<(?:${DELIVERY_TAG_ALTERNATION})${TAG_NAME_END}[^>]*/>|<(${DELIVERY_TAG_ALTERNATION})${TAG_NAME_END}[^>]*>[\\s\\S]*?</\\1>`,
  'g',
);
const EMBEDDED_DELIVERY_OPEN_RE = new RegExp(
  `<(${DELIVERY_TAG_ALTERNATION})${TAG_NAME_END}[^>]*(?:/>|>)`,
  'g',
);
const EMPTY_FOLLOW_UP_SUMMARY = '(empty follow-up)';
const RESULT_RESPONSE_PREVIEW_LINES = 12;
const RESULT_RESPONSE_PREVIEW_CHARS = 1400;

function followupText(text: unknown): string | undefined {
  return typeof text === 'string' ? text : undefined;
}

export function stripOrchestratorFollowup(text: unknown): string {
  const normalized = followupText(text);
  if (normalized === undefined) return EMPTY_FOLLOW_UP_SUMMARY;

  const trimmed = normalized.trim();
  const match = trimmed.match(
    /^<orchestrator-followup>\s*([\s\S]*?)\s*<\/orchestrator-followup>$/,
  );
  return match?.[1]?.trim() ?? normalized;
}

function attr(xml: string, name: string): string | undefined {
  return new RegExp(`\\b${escapeRegExp(name)}="([^"]*)"`).exec(xml)?.[1];
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

function progressDetail(xml: string): string {
  switch (attr(xml, 'type')) {
    case 'started':
      return 'started';
    case 'overview': {
      const calls = attr(xml, 'tool-calls');
      const cost = attr(xml, 'cost');
      const parts: string[] = [];
      if (calls) parts.push(`${calls} tool call${calls === '1' ? '' : 's'}`);
      if (cost) parts.push(`$${cost}`);
      return parts.length > 0 ? parts.join(' · ') : 'working';
    }
    case 'round': {
      const current = attr(xml, 'current');
      const total = attr(xml, 'total');
      return current && total ? `round ${current}/${total}` : 'working';
    }
    case 'plan':
      return attr(xml, 'status') === 'cleared'
        ? 'plan cleared'
        : `plan · ${attr(xml, 'steps') ?? '0'} steps`;
    case 'todos': {
      const completed = attr(xml, 'completed');
      const active = attr(xml, 'active');
      const pending = attr(xml, 'pending');
      if (completed || active || pending) {
        return `todos · ${completed ?? '0'} done, ${active ?? '0'} active, ${pending ?? '0'} pending`;
      }
      const body = elementBody(xml, 'subagent-progress');
      if (!body) return 'todos updated';
      const parsed = safeParseJson(decodeXmlEntities(body));
      if (parsed.isErr() || !Array.isArray(parsed.value)) {
        return 'todos updated';
      }
      let done = 0;
      let inProgress = 0;
      let todo = 0;
      for (const item of parsed.value) {
        const status =
          typeof item === 'object' && item !== null && 'status' in item
            ? item.status
            : undefined;
        if (status === 'completed') done += 1;
        else if (status === 'in_progress') inProgress += 1;
        else todo += 1;
      }
      return `todos · ${done} done, ${inProgress} active, ${todo} pending`;
    }
    case 'conversations': {
      const turns = attr(xml, 'turns');
      const chars = attr(xml, 'characters');
      const parts: string[] = [];
      if (turns) parts.push(`${turns} turns`);
      if (chars) parts.push(`${chars} chars`);
      return parts.length > 0
        ? `conversation · ${parts.join(' · ')}`
        : 'conversation update';
    }
    case 'activity': {
      const body = elementBody(xml, 'subagent-progress');
      return body ? decodeXmlEntities(body).split('\n')[0]! : 'activity';
    }
    default:
      return 'working';
  }
}

function resultResponsePreview(response: string): string {
  const decoded = decodeXmlEntities(response).trim();
  if (decoded === '') return '';

  const lines = decoded.split('\n');
  const lineLimited = lines.length > RESULT_RESPONSE_PREVIEW_LINES;
  let preview = lines.slice(0, RESULT_RESPONSE_PREVIEW_LINES).join('\n');
  const charLimited = preview.length > RESULT_RESPONSE_PREVIEW_CHARS;
  if (charLimited) {
    preview = preview.slice(0, RESULT_RESPONSE_PREVIEW_CHARS).trimEnd();
  }

  if (!lineLimited && !charLimited) return decoded;

  const extraLines = lines.length - RESULT_RESPONSE_PREVIEW_LINES;
  const hidden = lineLimited
    ? formatResultCount(extraLines, 'more line')
    : 'more text';
  return `${preview}\n… ${hidden}; open the subagent transcript for the full response`;
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
  const tag = SUBAGENT_TAG_RE.exec(trimmed)?.[1];
  if (!tag) return normalized;

  if (tag === DELIVERY_TAG.subagentProgress) {
    const agent = attr(trimmed, 'agent') ?? 'subagent';
    return `⟳ ${agent} · ${progressDetail(trimmed)}`;
  }

  // Result/error envelopes share one shape across families
  // (formatChildRunDelivery/formatChildRunError): subagent-*, background-*,
  // codex-*, claude-agent-*. Agent-CLI producers (codex.ts, claudeAgent.ts)
  // don't set an `agent` attribute, so fall back to the tag's own family name
  // (e.g. `codex-result` → `codex`) rather than the generic `subagent`.
  if (tag.endsWith('-result')) {
    const agent = attr(trimmed, 'agent') ?? tag.slice(0, -'-result'.length);
    const status = attr(trimmed, 'status') ?? 'completed';
    const wall = innerTag(trimmed, 'wall-time');
    const response = innerTag(trimmed, 'response');
    const head = `✓ ${agent} ${status}${wall ? ` · ${wall}` : ''}`;
    const preview = response ? resultResponsePreview(response) : '';
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

  // Activity envelopes (github-webhook-activity, execution-activity) wrap a
  // plain sanitized text body — no attribute schema, so surface its first
  // line instead of the raw wrapper tags.
  const body = elementBody(trimmed, tag);
  const firstLine = body?.split('\n')[0]?.trim();
  return firstLine || normalized;
}

export function summarizeFollowupMessage(text: unknown): string {
  return summarizeSubagentFollowup(stripOrchestratorFollowup(text));
}

type IncompleteEmbeddedSubagentFollowup = {
  readonly index: number;
  readonly block: string;
};

function containsEmbeddedDeliveryTag(text: string): boolean {
  return DELIVERY_TAG_NAMES.some((tag) => text.includes(`<${tag}`));
}

function findIncompleteEmbeddedSubagentFollowup(
  text: string,
): IncompleteEmbeddedSubagentFollowup | undefined {
  for (const match of text.matchAll(EMBEDDED_DELIVERY_OPEN_RE)) {
    const index = match.index;
    const tag = match[1];
    const opening = match[0];
    if (index === undefined || tag === undefined || opening.endsWith('/>')) {
      continue;
    }

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
    containsEmbeddedDeliveryTag(text) &&
    findIncompleteEmbeddedSubagentFollowup(text) !== undefined
  );
}

export function summarizeEmbeddedSubagentFollowups(text: string): string {
  if (!containsEmbeddedDeliveryTag(text)) return text;
  const completeSummarized = text.replaceAll(
    EMBEDDED_DELIVERY_BLOCK_RE,
    (block) => summarizeSubagentFollowup(block),
  );
  const incomplete = findIncompleteEmbeddedSubagentFollowup(completeSummarized);
  if (!incomplete) return completeSummarized;
  return `${completeSummarized.slice(0, incomplete.index)}${summarizeSubagentFollowup(incomplete.block)}`;
}
