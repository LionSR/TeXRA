import { html, nothing, type TemplateResult } from 'lit';
import type { ConversationProgress, RoundStage } from '@shared/schemas';
import { formatRoundStageLabel } from '@shared/streams/streamStatusDisplay';

/**
 * Render progress badge with conversation turns and tool call count.
 * Used by StreamHeader.
 */
export function renderProgressBadgeContent(
  progress: ConversationProgress | undefined,
  roundStage: RoundStage | undefined,
): TemplateResult | typeof nothing {
  const round = formatRoundStageLabel(roundStage);
  const tools = progress?.toolCallCount ?? 0;
  if (!round && tools <= 0) return nothing;
  if (round && tools > 0) return html`${round}, ${tools} tool calls`;
  if (round) return html`${round}`;
  return html`${tools} tool calls`;
}

export function getProgressBadgeTitle(
  progress: ConversationProgress | undefined,
  roundStage: RoundStage | undefined,
): string | undefined {
  const parts: string[] = [];
  if (roundStage) {
    parts.push(
      roundStage.total !== undefined
        ? `Round ${roundStage.index + 1} of ${roundStage.total}`
        : `Round ${roundStage.index + 1}`,
    );
  }
  if (progress?.toolCallCount) {
    parts.push(`Tool calls: ${progress.toolCallCount}`);
  }
  return parts.length ? parts.join(', ') : undefined;
}
