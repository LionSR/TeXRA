// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';

// Local imports - shared contracts
import {
  WORKFLOW_TASK_STATUS_LABEL,
  WorkflowTaskProgressSchema,
  type LogMessageData,
  type WorkflowTaskProgress,
} from '@shared/schemas';
import {
  formatWorkflowTaskMetadataParts,
  workflowTaskDetail,
} from '@shared/copy/workflowTask';
import { waIcon, type TeXRAIconName } from '@shared/wa/webAwesomeIcons';
import { assertNever } from '@utils/core';

function statusIcon(task: WorkflowTaskProgress): TemplateResult {
  if (task.status === 'running') {
    return html`<wa-spinner aria-label="Running"></wa-spinner>`;
  }
  const icon: TeXRAIconName = (() => {
    switch (task.status) {
      case 'planned':
        return 'circle-outline';
      case 'completed':
      case 'cached':
        return 'check';
      case 'skipped':
        return 'circle-stop';
      case 'failed':
        return 'error';
      default:
        return assertNever(task, 'Unhandled workflow task status');
    }
  })();
  return waIcon(icon);
}

function terminalMetadata(
  task: WorkflowTaskProgress,
): TemplateResult | typeof nothing {
  const parts = formatWorkflowTaskMetadataParts(task);
  return parts.length > 0
    ? html`<span class="workflow-task-meta">${parts.join(' · ')}</span>`
    : nothing;
}

/** Render one workflow task as a status card updated in place by log id. */
export function formatWorkflowTaskTemplate(
  message: LogMessageData,
): TemplateResult {
  const task = WorkflowTaskProgressSchema.parse(message.data);
  const detail = workflowTaskDetail(task);

  return html`
    <div
      class=${`workflow-task workflow-task--${task.status}`}
      data-log-id=${message.id}
      data-group-id=${message.groupId ?? ''}
    >
      <span class="workflow-task-icon">${statusIcon(task)}</span>
      <span class="workflow-task-body">
        <span class="workflow-task-title">${task.label}</span>
        ${terminalMetadata(task)}
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
        >${WORKFLOW_TASK_STATUS_LABEL[task.status]}</span
      >
    </div>
  `;
}
