import { html, nothing, type TemplateResult } from 'lit';
import type { ConversationProgress, RoundStage } from '@shared/schemas';

/**
 * Render progress badge with conversation turns and tool call count.
 * Used by StreamHeader.
 */
export function renderProgressBadgeContent(
  progress: ConversationProgress | undefined,
  roundStage: RoundStage | undefined,
): TemplateResult | typeof nothing {
  let round: string | undefined;
  if (roundStage === undefined) {
    round = undefined;
  } else if (roundStage.total !== undefined) {
    round = `r${roundStage.index + 1}/${roundStage.total}`;
  } else {
    round = `r${roundStage.index + 1}`;
  }
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
