// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';

// Local imports - shared contracts
import {
  WORKFLOW_TASK_STATUS_LABEL,
  WorkflowTaskProgressSchema,
  type LogMessageData,
  type WorkflowTaskProgress,
} from '@shared/schemas';
import { formatWorkflowTaskMetadataParts } from '@shared/copy/workflowTask';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';
import { assertNever } from '@utils/core';

function statusIcon(task: WorkflowTaskProgress): TemplateResult {
  if (task.status === 'running') {
    return html`<wa-spinner aria-label="Running"></wa-spinner>`;
  }
  const icon = (() => {
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
  return html`<wa-icon
    library=${TEXRA_ICON_LIBRARY}
    name=${icon}
    aria-hidden="true"
  ></wa-icon>`;
}

function terminalMetadata(
  task: WorkflowTaskProgress,
): TemplateResult | typeof nothing {
  const parts = formatWorkflowTaskMetadataParts(task);
  return parts.length > 0
    ? html`<span class="workflow-task-meta">${parts.join(' · ')}</span>`
    : nothing;
}

type WorkflowTaskDetail =
  | { readonly kind: 'error'; readonly text: string }
  | { readonly kind: 'note'; readonly text: string };

function taskDetail(
  task: WorkflowTaskProgress,
): WorkflowTaskDetail | undefined {
  if (task.status === 'failed') {
    return { kind: 'error', text: task.error };
  }
  if (task.status === 'skipped' && task.reason === 'not-reached') {
    return {
      kind: 'note',
      text: 'The workflow ended before this task was reached.',
    };
  }
  return undefined;
}

/** Render one workflow task as a status card updated in place by log id. */
export function formatWorkflowTaskTemplate(
  message: LogMessageData,
): TemplateResult {
  const task = WorkflowTaskProgressSchema.parse(message.data);
  const detail = taskDetail(task);

  return html`
    <div
      class=${`workflow-task workflow-task--${task.status}`}
      data-log-id=${message.id}
      data-group-id=${message.groupId ?? ''}
    >
      <span class="workflow-task-icon">${statusIcon(task)}</span>
      <span class="workflow-task-body">
        <span class="workflow-task-title">${task.label}</span>
        <span class="workflow-task-details">
          ${
            task.phase
              ? html`<span class="workflow-task-phase">${task.phase}</span>`
              : nothing
          }
          ${terminalMetadata(task)}
        </span>
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
