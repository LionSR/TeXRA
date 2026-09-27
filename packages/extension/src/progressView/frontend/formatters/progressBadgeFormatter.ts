import { html, nothing, type TemplateResult } from 'lit';
import type {
  AgentCategory,
  ConversationProgress,
  RunFlow,
} from '@shared/schemas';
import {
  flowPosition,
  formatFlowPositionTitle,
} from '@shared/runs/runStatusDisplay';
import { formatResultCount } from '@utils/text/stringUtils';

/**
 * The run header's progress chip, in words: "3 tool calls", or "Round 2 ·
 * 3 tool calls" for a workflow run. A tool-use turn number stays in the
 * tooltip ({@link getProgressBadgeTitle}): the conversation already shows
 * the turns. Used by RunHeader.
 */
export function renderProgressBadgeContent(
  progress: ConversationProgress | undefined,
  flow: RunFlow | null,
  category: AgentCategory,
): TemplateResult | typeof nothing {
  const position = flowPosition(flow, category);
  const tools = progress?.toolCallCount ?? 0;
  const label = [
    position?.kind === 'round' ? formatFlowPositionTitle(position) : undefined,
    tools > 0 ? formatResultCount(tools, 'tool call') : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return label ? html`<bdi dir="auto">${label}</bdi>` : nothing;
}

/** The spelled-out position and count: "Turn 1 · 3 tool calls". */
export function getProgressBadgeTitle(
  progress: ConversationProgress | undefined,
  flow: RunFlow | null,
  category: AgentCategory,
): string | undefined {
  const parts: string[] = [];
  const flowTitle = formatFlowPositionTitle(flowPosition(flow, category));
  if (flowTitle) {
    parts.push(flowTitle);
  }
  if (progress?.toolCallCount) {
    parts.push(formatResultCount(progress.toolCallCount, 'tool call'));
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
