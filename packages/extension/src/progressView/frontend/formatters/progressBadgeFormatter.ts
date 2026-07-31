import { html, nothing, type TemplateResult } from 'lit';
import type {
  ConversationProgress,
  PhaseStage,
  RoundStage,
} from '@shared/schemas';
import {
  formatPhaseStageLabel,
  formatRoundStageLabel,
} from '@shared/streams/streamStatusDisplay';
import { formatResultCount } from '@utils/text/stringUtils';

/**
 * The stage slot of the progress badge. A workflow-script run advances through
 * named phases, a tool-use run through numbered rounds; one slot carries
 * whichever this stream has, phase first.
 */
interface ProgressBadgeStage {
  phaseStage: PhaseStage | undefined;
  roundStage: RoundStage | undefined;
}

/**
 * Render progress badge with the stage slot and tool call count.
 * Used by StreamHeader.
 */
export function renderProgressBadgeContent(
  progress: ConversationProgress | undefined,
  stage: ProgressBadgeStage,
): TemplateResult | typeof nothing {
  const stageLabel =
    formatPhaseStageLabel(stage.phaseStage) ??
    formatRoundStageLabel(stage.roundStage);
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
  stage: ProgressBadgeStage,
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

/** Spelled-out counterpart of the compact stage label, phase first. */
function stageBadgeTitle({
  phaseStage,
  roundStage,
}: ProgressBadgeStage): string | undefined {
  if (phaseStage) {
    if (phaseStage.index === undefined) return `Phase: ${phaseStage.label}`;
    const position =
      phaseStage.total === undefined
        ? `Phase ${phaseStage.index + 1}`
        : `Phase ${phaseStage.index + 1} of ${phaseStage.total}`;
    return `${position}: ${phaseStage.label}`;
  }
  if (roundStage) {
    const round = `Round ${roundStage.index + 1}`;
    return roundStage.total !== undefined
      ? `${round} of ${roundStage.total}`
      : round;
  }
  return undefined;
}
