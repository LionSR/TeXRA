// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';

// Local imports - shared contracts
import {
  WORKFLOW_CALL_STATUS_LABEL,
  WorkflowCallProgressSchema,
  type LogMessageData,
  type WorkflowCallProgress,
} from '@shared/schemas';
import {
  formatWorkflowCallMetadataParts,
  workflowCallDetail,
} from '@shared/copy/workflowCall';
import { waIcon, type TeXRAIconName } from '@shared/wa/webAwesomeIcons';
import { assertNever } from '@utils/core';

function statusIcon(call: WorkflowCallProgress): TemplateResult {
  if (call.status === 'running') {
    return html`<wa-spinner aria-label="Running"></wa-spinner>`;
  }
  const icon: TeXRAIconName = (() => {
    switch (call.status) {
      case 'planned':
        return 'circle';
      case 'completed':
      case 'cached':
        return 'check';
      case 'skipped':
        return 'circle-stop';
      case 'failed':
        return 'circle-exclamation';
      default:
        return assertNever(call, 'Unhandled workflow call status');
    }
  })();
  return waIcon(icon);
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

  return html`
    <div
      class=${`workflow-task workflow-task--${call.status}`}
      data-log-id=${message.id}
      data-group-id=${message.groupId ?? ''}
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
        >${WORKFLOW_CALL_STATUS_LABEL[call.status]}</span
      >
    </div>
  `;
}
