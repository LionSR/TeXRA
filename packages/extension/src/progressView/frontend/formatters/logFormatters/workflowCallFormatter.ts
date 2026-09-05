// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';

// Local imports - progress view

// Local imports - shared contracts
import { type StreamTabId, type WorkflowCallProgress } from '@shared/schemas';
import type { WorkflowTaskRow } from '@shared/transcript';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { terminalStatusIcon } from '@shared/wa/statusIcons';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { assertNever } from '@utils/core';

/** One icon per call status, for a card and for a board row alike. */
export function workflowCallStatusIcon(
  status: WorkflowCallProgress['status'],
): Parameters<typeof waIcon>[0] {
  switch (status) {
    case 'declared':
      return 'circle';
    case 'planned':
    case 'queued':
      return 'circle-dot';
    case 'running':
      return terminalStatusIcon('running');
    case 'completed':
      return terminalStatusIcon('completed');
    case 'cached':
      // A replayed result from an earlier attempt: nothing ran this time.
      return 'clock-rotate-left';
    case 'skipped':
    case 'cancelled':
      return terminalStatusIcon('cancelled');
    case 'failed':
      return terminalStatusIcon('failed');
    default:
      return assertNever(status, 'Unhandled workflow call status');
  }
}

function callMetadata(
  parts: readonly string[],
): TemplateResult | typeof nothing {
  return parts.length > 0
    ? html`<span class="workflow-task-meta"
        >${parts.map(
          (part, index) =>
            html`${index === 0 ? nothing : ' · '}<bdi dir="auto">${part}</bdi>`,
        )}</span
      >`
    : nothing;
}

/** Render one workflow call as a status card updated in place by log id;
 *  `liveParts` are the in-flight segments the run model joins to it, and
 *  `childStreamId` is the stream this card opens. Both are resolved by the
 *  caller — the run model refuses a stream two cards claim, and passing its
 *  answer in (rather than defaulting to the card's own field) keeps an
 *  unresolved id from silently reviving the raw one. */
export function formatWorkflowCallTemplate(
  row: WorkflowTaskRow,
  liveParts: readonly string[],
  childStreamId: StreamTabId | undefined,
): TemplateResult {
  const { call, detail } = row;
  const hasChildStream = childStreamId !== undefined;
  const openChildStream = (event: Event): void => {
    if (childStreamId === undefined) return;
    event.currentTarget?.dispatchEvent(
      SessionUiEvents.surface({ kind: 'select', streamId: childStreamId }),
    );
  };
  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openChildStream(event);
  };

  return html`
    <div
      class=${`workflow-task workflow-task--${call.status}${
        hasChildStream ? ' workflow-task--linked' : ''
      }`}
      data-log-id=${row.id}
      data-group-id=${row.groupId ?? ''}
      role=${hasChildStream ? 'button' : nothing}
      tabindex=${hasChildStream ? '0' : nothing}
      aria-label=${
        hasChildStream ? `${call.label}, ${row.statusLabel}. Open run` : nothing
      }
      @click=${hasChildStream ? openChildStream : nothing}
      @keydown=${hasChildStream ? handleKeydown : nothing}
    >
      <span class="workflow-task-icon"
        >${waIcon(workflowCallStatusIcon(call.status))}</span
      >
      <span class="workflow-task-body">
        <bdi class="workflow-task-title" dir="auto">${call.label}</bdi>
        ${callMetadata([...row.metadataParts, ...liveParts])}
        ${
          detail
            ? html`<span
                class=${`workflow-task-detail workflow-task-detail--${detail.kind}`}
                ><bdi dir="auto">${detail.text}</bdi></span
              >`
            : nothing
        }
      </span>
      <span class="workflow-task-status">${row.statusLabel}</span>
    </div>
  `;
}
