import { html, nothing, type TemplateResult } from 'lit';
import type { ConversationProgress, StreamStage } from '@shared/schemas';
import { formatStageLabel } from '@shared/streams/streamStatusDisplay';
import { formatResultCount } from '@utils/text/stringUtils';

/**
 * Render progress badge with the stage slot and tool call count.
 * Used by StreamHeader.
 */
export function renderProgressBadgeContent(
  progress: ConversationProgress | undefined,
  stage: StreamStage | undefined,
): TemplateResult | typeof nothing {
  const stageLabel = formatStageLabel(stage);
  const tools = progress?.toolCallCount ?? 0;
  const parts = [
    stageLabel ?? '',
    tools > 0 ? formatResultCount(tools, 'tool call') : '',
  ].filter(Boolean);
  if (parts.length === 0) return nothing;
  return html`${parts.join(', ')}`;
}

export function getProgressBadgeTitle(
  progress: ConversationProgress | undefined,
  stage: StreamStage | undefined,
): string | undefined {
  const parts: string[] = [];
  const stageTitle = stageBadgeTitle(stage);
  if (stageTitle) {
    parts.push(stageTitle);
  }
  if (progress?.toolCallCount) {
    parts.push(`Tool calls: ${progress.toolCallCount}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** Spelled-out counterpart of the compact stage label. */
function stageBadgeTitle(stage: StreamStage | undefined): string | undefined {
  if (stage === undefined) return undefined;
  if (stage.kind === 'phase') {
    if (stage.index === undefined) return `Phase: ${stage.label}`;
    const position =
      stage.total === undefined
        ? `Phase ${stage.index + 1}`
        : `Phase ${stage.index + 1} of ${stage.total}`;
    return `${position}: ${stage.label}`;
  }
  const round = `Round ${stage.index + 1}`;
  return stage.total !== undefined ? `${round} of ${stage.total}` : round;
}
