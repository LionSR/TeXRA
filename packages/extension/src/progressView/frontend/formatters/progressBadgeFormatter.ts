import { html, nothing, type TemplateResult } from 'lit';
import type { ConversationProgress, RunFlow } from '@shared/schemas';
import {
  flowPosition,
  formatFlowPositionLabel,
} from '@shared/runs/runStatusDisplay';
import { formatResultCount } from '@utils/text/stringUtils';

/**
 * Render progress badge with the loop position and tool call count.
 * Used by RunHeader.
 */
export function renderProgressBadgeContent(
  progress: ConversationProgress | undefined,
  flow: RunFlow | null,
): TemplateResult | typeof nothing {
  const flowLabel = formatFlowPositionLabel(flowPosition(flow));
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

/** Spelled-out counterpart of the compact position label, on the same
 *  family-selected coordinate. */
function flowBadgeTitle(flow: RunFlow | null): string | undefined {
  const position = flowPosition(flow);
  if (position === undefined) return undefined;
  const noun = position.kind === 'round' ? 'Round' : 'Turn';
  return `${noun} ${position.index + 1}`;
}
