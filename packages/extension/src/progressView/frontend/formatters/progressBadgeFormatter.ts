import { html, nothing, type TemplateResult } from 'lit';
import type { ConversationProgress } from '@shared/schemas';
import { formatRoundStageLabel } from '@shared/runs/runStatusDisplay';
import type { RunView } from '@shared/session/sessionView';
import { formatResultCount } from '@utils/text/stringUtils';

/** The loop position the fold carries for a run (`RunView.flow`). */
type RunFlow = NonNullable<RunView['flow']>;

/**
 * Render progress badge with the loop position and tool call count.
 * Used by RunHeader.
 */
export function renderProgressBadgeContent(
  progress: ConversationProgress | undefined,
  flow: RunFlow | null,
): TemplateResult | typeof nothing {
  const flowLabel = compactFlowLabel(flow);
  const tools = progress?.toolCallCount ?? 0;
  if (!flowLabel && tools <= 0) return nothing;

  const accessibleLabel = getProgressBadgeTitle(progress, flow);
  return html`<span aria-hidden="true"
      >${flowLabel ? html`<bdi dir="auto">${flowLabel}</bdi>` : nothing}${
        flowLabel && tools > 0 ? ', ' : nothing
      }${tools > 0 ? formatResultCount(tools, 'tool call') : nothing}</span
    >${
      accessibleLabel
        ? html`<span class="visually-hidden"
            ><bdi dir="auto">${accessibleLabel}</bdi></span
          >`
        : nothing
    }`;
}

export function getProgressBadgeTitle(
  progress: ConversationProgress | undefined,
  flow: RunFlow | null,
): string | undefined {
  const parts: string[] = [];
  const flowTitle = flowBadgeTitle(flow);
  if (flowTitle) {
    parts.push(flowTitle);
  }
  if (progress?.toolCallCount) {
    parts.push(`Tool calls: ${progress.toolCallCount}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** The loop's position in the compact form the status surfaces share: the
 *  round a reflection run is on, else the turn a tool-use run is on. A step
 *  that carries neither coordinate has no position to paint. */
function compactFlowLabel(flow: RunFlow | null): string | undefined {
  if (flow == null) return undefined;
  if (flow.round != null) return formatRoundStageLabel({ index: flow.round });
  if (flow.turn != null) return `t${flow.turn + 1}`;
  return undefined;
}

/** Spelled-out counterpart of the compact position label. */
function flowBadgeTitle(flow: RunFlow | null): string | undefined {
  if (flow == null) return undefined;
  if (flow.round != null) return `Round ${flow.round + 1}`;
  if (flow.turn != null) return `Turn ${flow.turn + 1}`;
  return undefined;
}
