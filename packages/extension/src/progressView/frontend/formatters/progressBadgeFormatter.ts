import { html, nothing, type TemplateResult } from 'lit';
import type { ConversationProgress } from '@shared/schemas';
import { formatLoopPositionTitle } from '@shared/runs/runStatusDisplay';
import type { LoopCoordinate } from '@shared/session/sessionView';
import { formatResultCount } from '@utils/text/stringUtils';

/**
 * The run header's progress chip, in words: "3 tool calls", or "Round 2 ·
 * 3 tool calls" for a workflow run. A tool-use turn number stays in the
 * tooltip ({@link getProgressBadgeTitle}): the conversation already shows
 * the turns. Used by RunHeader.
 */
export function renderProgressBadgeContent(
  progress: ConversationProgress | undefined,
  position: LoopCoordinate | null,
): TemplateResult | typeof nothing {
  const tools = progress?.toolCallCount ?? 0;
  const label = [
    position?.kind === 'round' ? formatLoopPositionTitle(position) : undefined,
    tools > 0 ? formatResultCount(tools, 'tool call') : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return label ? html`<bdi dir="auto">${label}</bdi>` : nothing;
}

/** The spelled-out position and count: "Turn 1 · 3 tool calls". */
export function getProgressBadgeTitle(
  progress: ConversationProgress | undefined,
  position: LoopCoordinate | null,
): string | undefined {
  const parts: string[] = [];
  const title = formatLoopPositionTitle(position);
  if (title) parts.push(title);
  if (progress?.toolCallCount) {
    parts.push(formatResultCount(progress.toolCallCount, 'tool call'));
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
