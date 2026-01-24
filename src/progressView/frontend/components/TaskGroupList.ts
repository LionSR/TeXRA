// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { guard } from 'lit/directives/guard.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Local imports - common
import { setChevronIconHorizontal } from '@common/modules/domUtils.js';
import { STREAM_STATUS } from '@common/constants/streamStatus';

// Local imports - progress view
import { GROUP_DOM_IDS } from '../constants';
import { TaskGroupLevel } from '../formatters/taskGroupLevel.js';
import {
  formatDuration,
  getDateTimeFormatter,
  getTimeFormatter,
} from '../formatters/timestampUtils.js';
import { formatLogEntry } from '../formatters/logFormatter';

// Local types
import type { LogMessageData, TaskGroup } from '@shared/schemas';

const EMPTY_PLACEHOLDER_HTML =
  'No runs yet—use TeXRA commands to start. Try ' +
  '<a href="command:texra.openGettingStarted">open the getting started walkthrough</a>, ' +
  '<a href="command:texra.createSampleProject">create a sample project</a>, ' +
  '<a href="command:texra.cloneOverleafProject">clone an Overleaf project</a>, or ' +
  '<a href="command:texra.downloadArXivSource">download an arXiv source</a>.';

type GroupItem =
  | { type: 'log'; timestamp: number; log: LogMessageData }
  | { type: 'group'; timestamp: number; group: TaskGroup };

@customElement('task-group-list')
export class TaskGroupList extends LitElement {
  @property({ type: Array }) groups: TaskGroup[] = [];
  @property({ type: Array }) logs: LogMessageData[] = [];

  @state() private collapsedGroups = new Map<string, boolean>();

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  private toTime(value?: number | string) {
    if (typeof value === 'number') return value;
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  private getGroupStatusIcon(status: string) {
    switch (status) {
      case STREAM_STATUS.RUNNING:
        return html`<i class="codicon codicon-sync spin"></i>`;
      case STREAM_STATUS.ERROR:
        return html`<i class="codicon codicon-error"></i>`;
      case STREAM_STATUS.STOPPED:
        return html`<i class="codicon codicon-check"></i>`;
      default:
        return html`<i class="codicon codicon-circle-outline"></i>`;
    }
  }

  private renderGroupHeader(group: TaskGroup) {
    const level = group.parentGroupId
      ? TaskGroupLevel.NESTED
      : TaskGroupLevel.ROOT;
    const formatter =
      level === TaskGroupLevel.ROOT
        ? getDateTimeFormatter()
        : getTimeFormatter();
    const formattedStartTime = level.formatTime(
      new Date(group.startTime),
      formatter,
    );
    const showTitle = level.showTitle;

    return html`
      <summary
        id=${`${GROUP_DOM_IDS.HEADER_PREFIX}${group.id}`}
        class=${`log-group-header is-${group.status}${
          level.cssClass ? ` ${level.cssClass}` : ''
        }`}
      >
        <span class="group-status-icon"
          >${this.getGroupStatusIcon(group.status)}</span
        >
        ${showTitle
          ? html`<span class="group-title">${group.name}</span>`
          : null}
        <span
          class="group-time group-start-time"
          data-start=${String(group.startTime)}
        >
          <i class="codicon codicon-clock"></i>
          ${formattedStartTime}
        </span>
        ${group.endTime ? html`<span class="group-bullet">•</span>` : null}
        ${group.endTime
          ? html`<span class="group-time group-duration"
              >${formatDuration(group.endTime - group.startTime)}</span
            >`
          : null}
      </summary>
    `;
  }

  private renderLogEntry(log: LogMessageData) {
    return guard(
      [log.id, log.text, log.timestamp, log.messageType, log.level],
      () => formatLogEntry(log),
    );
  }

  private buildItems(parentId: string | null) {
    const childGroups = this.groups.filter(
      (group) => (group.parentGroupId ?? null) === parentId,
    );
    const childLogs = this.logs.filter(
      (log) => (log.groupId ?? null) === parentId,
    );

    const items: GroupItem[] = [
      ...childGroups.map((group) => ({
        type: 'group' as const,
        group,
        timestamp: this.toTime(group.startTime),
      })),
      ...childLogs.map((log) => ({
        type: 'log' as const,
        log,
        timestamp: this.toTime(log.timestamp),
      })),
    ];

    return items.sort((a, b) => a.timestamp - b.timestamp);
  }

  private renderItems(parentId: string | null): Array<unknown> {
    const items = this.buildItems(parentId);
    return items.map((item) => {
      if (item.type === 'log') {
        return this.renderLogEntry(item.log);
      }
      return this.renderGroup(item.group);
    });
  }

  private handleToggle(event: Event) {
    const target = event.target as HTMLElement | null;
    if (!target || target.tagName !== 'DETAILS') return;
    const details = target as HTMLDetailsElement;
    const id = details.id.replace(GROUP_DOM_IDS.DETAILS_PREFIX, '');
    if (!id) return;
    this.collapsedGroups = new Map(this.collapsedGroups).set(id, !details.open);
    const toggleIcon = details.querySelector('.toggle-icon');
    if (toggleIcon) {
      setChevronIconHorizontal(toggleIcon, details.open);
    }
  }

  private renderGroup(group: TaskGroup): ReturnType<typeof html> {
    const isRoot = !group.parentGroupId;
    const content = this.renderItems(group.id);
    const contentId = `${GROUP_DOM_IDS.CONTENT_PREFIX}${group.id}`;

    if (isRoot) {
      return html`
        <div
          id=${`${GROUP_DOM_IDS.DETAILS_PREFIX}${group.id}`}
          class="log-group log-run"
          data-run-id=${group.id}
        >
          <div class="log-group-content" id=${contentId}>${content}</div>
        </div>
      `;
    }

    const isCollapsed = this.collapsedGroups.get(group.id) === true;
    return html`
      <details
        id=${`${GROUP_DOM_IDS.DETAILS_PREFIX}${group.id}`}
        class="log-group"
        ?open=${!isCollapsed}
        @toggle=${this.handleToggle}
      >
        ${this.renderGroupHeader(group)}
        <div class="log-group-content" id=${contentId}>${content}</div>
      </details>
    `;
  }

  override render() {
    if (this.logs.length === 0 && this.groups.length === 0) {
      return html`
        <div class="log-container" id="logContent">
          <div class="log-placeholder" id="logPlaceholder">
            ${unsafeHTML(EMPTY_PLACEHOLDER_HTML)}
          </div>
        </div>
      `;
    }

    return html`
      <div class="log-container" id="logContent">${this.renderItems(null)}</div>
    `;
  }
}
