// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';

// Local imports - progress view
import { ProgressEvents } from '@progressView/frontend/events';

// Local imports - shared contracts
import type { WorkflowCallProgress } from '@shared/schemas';
import type { WorkflowTaskRow } from '@shared/transcript';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { terminalStatusIcon } from '@shared/wa/statusIcons';
import { assertNever } from '@utils/core';

function statusIcon(call: WorkflowCallProgress): TemplateResult {
  switch (call.status) {
    case 'planned':
    case 'running':
      return waIcon(terminalStatusIcon('running'));
    case 'completed':
    case 'cached':
      return waIcon(terminalStatusIcon('completed'));
    case 'skipped':
    case 'cancelled':
      return waIcon(terminalStatusIcon('cancelled'));
    case 'failed':
      return waIcon(terminalStatusIcon('failed'));
    default:
      return assertNever(call, 'Unhandled workflow call status');
  }
}

function terminalMetadata(
  parts: readonly string[],
): TemplateResult | typeof nothing {
  return parts.length > 0
    ? html`<span class="workflow-task-meta">${parts.join(' · ')}</span>`
    : nothing;
}

/** Render one workflow call as a status card updated in place by log id. */
export function formatWorkflowCallTemplate(
  row: WorkflowTaskRow,
): TemplateResult {
  const { call, detail } = row;
  const hasChildStream = call.childStreamId !== undefined;
  const openChildStream = (event: Event): void => {
    if (call.childStreamId === undefined) return;
    event.currentTarget?.dispatchEvent(
      ProgressEvents.streamSwitch({ streamId: call.childStreamId }),
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
      @click=${hasChildStream ? openChildStream : nothing}
      @keydown=${hasChildStream ? handleKeydown : nothing}
    >
      <span class="workflow-task-icon">${statusIcon(call)}</span>
      <span class="workflow-task-body">
        <span class="workflow-task-title">${call.label}</span>
        ${terminalMetadata(row.metadataParts)}
        ${
          detail
            ? html`<span
                class=${`workflow-task-detail workflow-task-detail--${detail.kind}`}
                >${detail.text}</span
              >`
            : nothing
        }
      </span>
      <span class="workflow-task-status">${row.statusLabel}</span>
    </div>
  `;
}
