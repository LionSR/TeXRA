// Host-neutral parsing/formatting for the subagent follow-up XML blocks
// produced by src/tools/subagentResults.ts (`<subagent-progress>`,
// `<subagent-result>`, `<subagent-error>`). These blocks are FollowUpQueue
// messages addressed to the orchestrator *model*, injected into the
// conversation as user turns.
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

const SUBAGENT_TAG_RE = /^<subagent-(?:progress|result|error)\b/;
const EMBEDDED_SUBAGENT_BLOCK_RE =
  /<subagent-(?:progress|result|error)\b[^>]*\/>|<subagent-(progress|result|error)\b[^>]*>[\s\S]*?<\/subagent-\1>/g;
const EMBEDDED_SUBAGENT_OPEN_RE =
  /<subagent-(progress|result|error)\b[^>]*(?:\/>|>)/g;
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
    ? `${extraLines} more line${extraLines === 1 ? '' : 's'}`
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
  if (!SUBAGENT_TAG_RE.test(trimmed)) return normalized;

  const agent = attr(trimmed, 'agent') ?? 'subagent';

  if (trimmed.startsWith('<subagent-progress')) {
    return `⟳ ${agent} · ${progressDetail(trimmed)}`;
  }

  if (trimmed.startsWith('<subagent-result')) {
    const status = attr(trimmed, 'status') ?? 'completed';
    const wall = innerTag(trimmed, 'wall-time');
    const response = innerTag(trimmed, 'response');
    const head = `✓ ${agent} ${status}${wall ? ` · ${wall}` : ''}`;
    const preview = response ? resultResponsePreview(response) : '';
    return preview ? `${head}\n${preview}` : head;
  }

  // <subagent-error>
  const wall = innerTag(trimmed, 'wall-time');
  const message = innerTag(trimmed, 'message');
  const retryable = attr(trimmed, 'retryable') === 'true';
  const head = `✗ ${agent} failed${wall ? ` · ${wall}` : ''}${retryable ? ' (retryable)' : ''}`;
  return message ? `${head}\n${decodeXmlEntities(message)}` : head;
}

export function summarizeFollowupMessage(text: unknown): string {
  return summarizeSubagentFollowup(stripOrchestratorFollowup(text));
}

type IncompleteEmbeddedSubagentFollowup = {
  readonly index: number;
  readonly block: string;
};

function findIncompleteEmbeddedSubagentFollowup(
  text: string,
): IncompleteEmbeddedSubagentFollowup | undefined {
  for (const match of text.matchAll(EMBEDDED_SUBAGENT_OPEN_RE)) {
    const index = match.index;
    const tag = match[1];
    const opening = match[0];
    if (index === undefined || tag === undefined || opening.endsWith('/>')) {
      continue;
    }

    const closing = new RegExp(`</subagent-${tag}>`, 'g');
    closing.lastIndex = index + opening.length;
    if (!closing.exec(text)) {
      return { index, block: text.slice(index) };
    }
  }
  return undefined;
}

export function hasIncompleteEmbeddedSubagentFollowup(text: string): boolean {
  return (
    text.includes('<subagent-') &&
    findIncompleteEmbeddedSubagentFollowup(text) !== undefined
  );
}

export function summarizeEmbeddedSubagentFollowups(text: string): string {
  if (!text.includes('<subagent-')) return text;
  const completeSummarized = text.replaceAll(
    EMBEDDED_SUBAGENT_BLOCK_RE,
    (block) => summarizeSubagentFollowup(block),
  );
  const incomplete = findIncompleteEmbeddedSubagentFollowup(completeSummarized);
  if (!incomplete) return completeSummarized;
  return `${completeSummarized.slice(0, incomplete.index)}${summarizeSubagentFollowup(incomplete.block)}`;
}
