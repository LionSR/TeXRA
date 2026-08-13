// Host-neutral parsing/formatting for the child-run delivery-envelope XML
// blocks whose tag vocabulary @shared/deliveryTags owns (`DELIVERY_TAGS`).
// These blocks are FollowUpQueue messages addressed to the orchestrator
// *model*, injected into the conversation as user turns.
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
import {
  DELIVERY_TAG,
  DELIVERY_TAGS,
  type DeliveryTagName,
} from '@shared/deliveryTags';
import {
  type SubagentProgressUpdate,
  WorkflowScriptDeliverySummarySchema,
  type WorkflowScriptDeliverySummary,
} from '@shared/schemas';
import { countByStatus, STATUS_DISPLAY } from '@shared/schemas/todoDisplay';
import { planSummaryLine } from '@shared/schemas/workPlan';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import {
  formatCompactDuration,
  formatCostUsd,
  formatResultCount,
} from '@utils/text/stringUtils';

// Derived from the single owned DELIVERY_TAGS list (@shared/deliveryTags), so
// a future child-run kind only needs one entry there and can never leak as raw
// XML into the CLI transcript or the queued follow-ups panel.
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
const DELIVERY_TAG_RE = new RegExp(
  `^<(${DELIVERY_TAG_ALTERNATION})${TAG_NAME_END}`,
);
// Embedded-block variants of the same recognizer, for delivery-envelope
// blocks that appear mid-stream inside assistant-role text rather than as a
// standalone follow-up message (see findIncompleteEmbeddedSubagentFollowup /
// summarizeEmbeddedSubagentFollowups below).
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

/**
 * The delivery-envelope tag `text` opens with, or undefined when the text is
 * not one of these blocks. The single recognizer for "is this a child-run
 * delivery envelope", shared by the CLI transcript, the queued follow-ups
 * panel, and the progress-view message bubble. Leading whitespace is allowed
 * because producers hand blocks to the render surfaces untrimmed.
 */
export function deliveryTagOf(text: string): DeliveryTagName | undefined {
  // Safe cast: the pattern's only alternation group is the DELIVERY_TAGS tag
  // names, so a match can only capture one of those values.
  return DELIVERY_TAG_RE.exec(text.trim())?.[1] as DeliveryTagName | undefined;
}

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

function progressDetail(xml: string): string | undefined {
  const type = attr(xml, 'type');
  switch (type) {
    case 'started':
      return 'started';
    case 'overview': {
      const calls = attr(xml, 'tool-calls');
      if (calls === undefined) return undefined;
      const cost = attr(xml, 'cost');
      const toolCalls = `${calls} tool call${calls === '1' ? '' : 's'}`;
      return cost ? `${toolCalls} · $${cost}` : toolCalls;
    }
    case 'plan': {
      const status = attr(xml, 'status');
      if (status === 'cleared') return 'plan cleared';
      // The producer (`formatSubagentProgress`) attaches the plan objective as
      // `summary`; there is no step count on the wire.
      const summary = attr(xml, 'summary');
      return status === 'updated' && summary !== undefined
        ? `plan · ${decodeXmlEntities(summary)}`
        : undefined;
    }
    case 'todos': {
      const completed = attr(xml, 'completed');
      const active = attr(xml, 'active');
      const pending = attr(xml, 'pending');
      if (
        completed === undefined ||
        active === undefined ||
        pending === undefined
      ) {
        return undefined;
      }
      return `todos · ${completed} done, ${active} active, ${pending} pending`;
    }
    default:
      return undefined;
  }
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

  const extraLines = lines.length - RESULT_RESPONSE_PREVIEW_LINES;
  const hidden = lineLimited
    ? formatResultCount(extraLines, 'more line')
    : 'more text';
  return `${preview}\n… ${hidden}; open the subagent transcript for the full response`;
}

/**
 * Read the presentation-only facts attached to a workflow delivery. The raw
 * response remains intact for the invoking model and diagnostic inspection.
 * This string parse lives at the delivery boundary — the transcript row
 * producer and the CLI summarizer — never at render time: renderers receive
 * the parsed summary carried beside the row text.
 */
export function parseWorkflowScriptDeliverySummary(
  xml: string,
): WorkflowScriptDeliverySummary | undefined {
  const rawSummary = innerTag(xml, 'workflow-summary');
  if (!rawSummary) return undefined;
  const parsedJson = safeParseJson(decodeXmlEntities(rawSummary));
  if (parsedJson.isErr()) return undefined;
  const parsed = WorkflowScriptDeliverySummarySchema.safeParse(
    parsedJson.value,
  );
  return parsed.success ? parsed.data : undefined;
}

/** Collapse a parsed workflow delivery summary to its transcript lines. */
export function formatWorkflowScriptDeliverySummary(
  summary: WorkflowScriptDeliverySummary,
): string {
  const marker = summary.outcome === 'completed' ? '✓' : '✗';
  const status = summary.outcome === 'completed' ? 'completed' : 'failed';
  const facts = [
    `${formatResultCount(summary.phaseCount, 'phase')}`,
    `${summary.taskDone}/${summary.taskTotal} tasks succeeded`,
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
    `${marker} ${summary.name} ${status} · ${facts.join(' · ')}`,
    ...(summary.outcome === 'failed' && summary.errorCause
      ? [truncatedResultResponsePreview(summary.errorCause)]
      : []),
    ...fileLines,
    `  script: ${summary.scriptPath}`,
    `  rerun: edit the script, then call delegate_multi_agents with scriptPath`,
  ].join('\n');
}

/** Format a typed progress update as XML for injection into orchestrator context. */
export function formatSubagentProgress(
  executionId: string,
  agentName: string,
  update: SubagentProgressUpdate,
): string {
  const tag = DELIVERY_TAG.subagentProgress;
  const idAttr = `id="${escapeAttr(executionId)}"`;
  const agentAttr = `agent="${escapeAttr(agentName)}"`;

  switch (update.kind) {
    case 'todos': {
      const { completed, inProgress, pending } = countByStatus(update.todos);
      const items = update.todos
        .map((t) => {
          const icon = STATUS_DISPLAY[t.status].icon;
          return `  ${icon} ${escapeText(t.content)}`;
        })
        .join('\n');
      return [
        `<${tag} ${idAttr} ${agentAttr} type="todos" completed="${completed}" active="${inProgress}" pending="${pending}">`,
        items,
        `</${tag}>`,
      ].join('\n');
    }

    case 'overview': {
      const fileList =
        update.filesChanged.length > 0
          ? update.filesChanged.map((f) => escapeAttr(f)).join(', ')
          : 'none';
      const attrs = [
        `type="overview"`,
        `tool-calls="${update.toolCallCount}"`,
        `files-changed="${fileList}"`,
      ];
      if (update.cost !== undefined) {
        attrs.push(`cost="${update.cost.toFixed(4)}"`);
      }
      return `<${tag} ${idAttr} ${agentAttr} ${attrs.join(' ')} />`;
    }

    case 'plan': {
      if (!update.plan) {
        return `<${tag} ${idAttr} ${agentAttr} type="plan" status="cleared" />`;
      }
      return `<${tag} ${idAttr} ${agentAttr} type="plan" status="updated" summary="${escapeAttr(planSummaryLine(update.plan.objective))}" />`;
    }

    case 'started':
      return `<${tag} ${idAttr} ${agentAttr} type="started" />`;
  }
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

  if (tag === DELIVERY_TAG.subagentProgress) {
    const agent = attr(trimmed, 'agent') ?? 'subagent';
    const detail = progressDetail(trimmed);
    return detail === undefined ? normalized : `⟳ ${agent} · ${detail}`;
  }

  if (
    tag === DELIVERY_TAG.workflowScriptResult ||
    tag === DELIVERY_TAG.workflowScriptError
  ) {
    const summary = parseWorkflowScriptDeliverySummary(trimmed);
    if (summary) return formatWorkflowScriptDeliverySummary(summary);
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
