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

import { escapeRegExp } from '@utils/core/stringCore';

const SUBAGENT_TAG_RE = /^<subagent-(?:progress|result|error)\b/;

export function stripOrchestratorFollowup(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(
    /^<orchestrator-followup>\s*([\s\S]*?)\s*<\/orchestrator-followup>$/,
  );
  return match?.[1]?.trim() ?? text;
}

function attr(xml: string, name: string): string | undefined {
  return new RegExp(`\\b${escapeRegExp(name)}="([^"]*)"`).exec(xml)?.[1];
}

function innerTag(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1]?.trim();
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
    case 'todos':
      return `todos · ${attr(xml, 'completed') ?? '0'} done, ${attr(xml, 'active') ?? '0'} active, ${attr(xml, 'pending') ?? '0'} pending`;
    default:
      return 'working';
  }
}

/**
 * Collapse a subagent follow-up XML block into a one-line (or, for results,
 * status + response) human-readable summary. Returns `text` unchanged when it
 * is not a subagent block.
 */
export function summarizeSubagentFollowup(text: string): string {
  const trimmed = text.trim();
  if (!SUBAGENT_TAG_RE.test(trimmed)) return text;

  const agent = attr(trimmed, 'agent') ?? 'subagent';

  if (trimmed.startsWith('<subagent-progress')) {
    return `⟳ ${agent} · ${progressDetail(trimmed)}`;
  }

  if (trimmed.startsWith('<subagent-result')) {
    const status = attr(trimmed, 'status') ?? 'completed';
    const wall = innerTag(trimmed, 'wall-time');
    const response = innerTag(trimmed, 'response');
    const head = `✓ ${agent} ${status}${wall ? ` · ${wall}` : ''}`;
    return response ? `${head}\n${decodeXmlEntities(response)}` : head;
  }

  // <subagent-error>
  const wall = innerTag(trimmed, 'wall-time');
  const message = innerTag(trimmed, 'message');
  const retryable = attr(trimmed, 'retryable') === 'true';
  const head = `✗ ${agent} failed${wall ? ` · ${wall}` : ''}${retryable ? ' (retryable)' : ''}`;
  return message ? `${head}\n${decodeXmlEntities(message)}` : head;
}

export function summarizeFollowupMessage(text: string): string {
  return summarizeSubagentFollowup(stripOrchestratorFollowup(text));
}
