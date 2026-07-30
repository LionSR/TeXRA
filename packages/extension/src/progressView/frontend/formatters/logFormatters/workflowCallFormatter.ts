// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';

// Local imports - progress view
import { ProgressEvents } from '@progressView/frontend/events';

// Local imports - shared contracts
import {
  WORKFLOW_TASK_STATUS_LABEL,
  WorkflowCallProgressSchema,
  type LogMessageData,
  type WorkflowCallProgress,
} from '@shared/schemas';
import {
  formatWorkflowCallMetadataParts,
  workflowCallDetail,
} from '@shared/copy/workflowCall';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { assertNever } from '@utils/core';

function statusIcon(call: WorkflowCallProgress): TemplateResult {
  switch (call.status) {
    case 'planned':
    case 'running':
      return waIcon('circle');
    case 'completed':
    case 'cached':
      return waIcon('check');
    case 'skipped':
      return waIcon('circle-stop');
    case 'failed':
      return waIcon('circle-exclamation');
    default:
      return assertNever(call, 'Unhandled workflow call status');
  }
}

function terminalMetadata(
  call: WorkflowCallProgress,
): TemplateResult | typeof nothing {
  const parts = formatWorkflowCallMetadataParts(call);
  return parts.length > 0
    ? html`<span class="workflow-task-meta">${parts.join(' · ')}</span>`
    : nothing;
}

/** Render one workflow call as a status card updated in place by log id. */
export function formatWorkflowCallTemplate(
  message: LogMessageData,
): TemplateResult {
  const call = WorkflowCallProgressSchema.parse(message.data);
  const detail = workflowCallDetail(call);
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
      data-log-id=${message.id}
      data-group-id=${message.groupId ?? ''}
      role=${hasChildStream ? 'button' : nothing}
      tabindex=${hasChildStream ? '0' : nothing}
      @click=${hasChildStream ? openChildStream : nothing}
      @keydown=${hasChildStream ? handleKeydown : nothing}
    >
      <span class="workflow-task-icon">${statusIcon(call)}</span>
      <span class="workflow-task-body">
        <span class="workflow-task-title">${call.label}</span>
        ${terminalMetadata(call)}
        ${
          detail
            ? html`<span
                class=${`workflow-task-detail workflow-task-detail--${detail.kind}`}
                >${detail.text}</span
              >`
            : nothing
        }
      </span>
      <span class="workflow-task-status"
        >${WORKFLOW_TASK_STATUS_LABEL[call.status]}</span
      >
    </div>
  `;
}
