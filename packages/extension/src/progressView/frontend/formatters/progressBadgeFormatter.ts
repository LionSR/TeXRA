import { html, type TemplateResult } from 'lit';
import { nothing } from 'lit';
import type { ConversationProgress } from '@shared/schemas';

/**
 * Render progress badge with conversation turns and tool call count.
 * Used by StreamHeader.
 */
export function renderProgressBadgeContent(
  progress: ConversationProgress | undefined,
): TemplateResult | typeof nothing {
  if (!progress?.conversationTurns) return nothing;
  return html`${progress.conversationTurns}
  turns${progress.toolCallCount > 0
    ? html`, ${progress.toolCallCount} tool calls`
    : nothing}`;
}

export function getProgressBadgeTitle(
  progress: ConversationProgress | undefined,
): string | undefined {
  if (!progress) return undefined;
  return `Conversation turns: ${progress.conversationTurns}, Tool calls: ${progress.toolCallCount}`;
}
