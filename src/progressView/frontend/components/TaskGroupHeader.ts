/**
 * Declarative task group header component.
 * Renders the collapsible summary with status icon, title, and timing.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - progress view constants
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';
import { STREAM_STATUS } from '../constants';

// Local imports - progress view styles
import { logStyles } from '../styles/logStyles';

// Local imports - formatter helpers
import {
  getDateTimeFormatter,
  getTimeFormatter,
  formatDuration,
} from '../formatters/timestampUtils';

// Local imports - shared schemas
import type { TaskGroup } from '@shared/schemas';

/** Maps group status to codicon class (with optional animation) */
function getStatusIcon(status: string): string {
  switch (status) {
    case STREAM_STATUS.RUNNING:
      return 'sync spin';
    case STREAM_STATUS.ERROR:
      return 'error';
    case STREAM_STATUS.STOPPED:
      return 'check';
    default:
      return 'circle-outline';
  }
}

@customElement('task-group-header')
export class TaskGroupHeader extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconStyles,
    ...logStyles,
    css`
      :host {
        display: contents;
      }
    `,
  ];

  @property({ type: Object }) group!: TaskGroup;

  override render(): TemplateResult {
    const { group } = this;
    const isRoot = !group.parentGroupId;
    const date = new Date(group.startTime);
    const formatter = isRoot ? getDateTimeFormatter() : getTimeFormatter();
    const formattedStartTime = formatter.format(date);
    const durationText = group.endTime
      ? formatDuration(group.endTime - group.startTime)
      : '';

    return html`
      <span class="group-status-icon">
        <i class="codicon codicon-${getStatusIcon(group.status)}"></i>
      </span>
      ${isRoot ? null : html`<span class="group-title">${group.name}</span>`}
      <span class="group-time">
        <span class="group-start-time" data-start=${String(group.startTime)}>
          <i class="codicon codicon-clock"></i> ${formattedStartTime}
        </span>
        ${durationText
          ? html`<span class="group-duration">${durationText}</span>`
          : null}
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'task-group-header': TaskGroupHeader;
  }
}
