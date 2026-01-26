/**
 * Declarative task group header component.
 * Renders the collapsible summary with status icon, title, and timing.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports - progress view constants
import { STREAM_STATUS } from '../constants';

// Local imports - formatter helpers
import {
  getDateTimeFormatter,
  getTimeFormatter,
  formatDuration,
} from '../formatters/timestampUtils';

// Local imports - shared schemas
import type { TaskGroup } from '@shared/schemas';

// Status icon mapping
const STATUS_ICONS: Record<string, string> = {
  [STREAM_STATUS.RUNNING]: 'sync spin',
  [STREAM_STATUS.ERROR]: 'error',
  [STREAM_STATUS.STOPPED]: 'check',
};

@customElement('task-group-header')
export class TaskGroupHeader extends LitElement {
  static override styles = css`
    :host {
      display: contents;
    }
  `;

  @property({ type: Object }) group!: TaskGroup;

  private get isRoot(): boolean {
    return !this.group.parentGroupId;
  }

  private get formattedStartTime(): string {
    const date = new Date(this.group.startTime);
    const formatter = this.isRoot ? getDateTimeFormatter() : getTimeFormatter();
    return formatter.format(date);
  }

  private get durationText(): string {
    if (!this.group.endTime) return '';
    return formatDuration(this.group.endTime - this.group.startTime);
  }

  private get iconClass(): string {
    return STATUS_ICONS[this.group.status] ?? 'circle-outline';
  }

  override render(): TemplateResult {
    const { group } = this;
    const showTitle = !this.isRoot;

    return html`
      <span class="group-status-icon">
        <i class=${`codicon codicon-${this.iconClass}`}></i>
      </span>
      ${showTitle ? html`<span class="group-title">${group.name}</span>` : null}
      <span class="group-time">
        <span class="group-start-time" data-start=${String(group.startTime)}>
          <i class="codicon codicon-clock"></i> ${this.formattedStartTime}
        </span>
        ${this.durationText
          ? html`<span class="group-duration">${this.durationText}</span>`
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
