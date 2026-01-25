/**
 * Task group header formatter for progress view.
 * Uses Lit templates for declarative DOM construction.
 */

// Local imports - Lit template utilities
import { html, when, classMap, renderToElement, type TemplateResult } from './litTemplates';

// Local imports - progress view constants
import { STREAM_STATUS, GROUP_DOM_IDS } from '../constants';

// Local imports - formatter helpers
import { TaskGroupLevel } from './taskGroupLevel';
import {
  getDateTimeFormatter,
  getTimeFormatter,
  formatDuration,
} from './timestampUtils';

// Local imports - shared schemas
import type { TaskGroup } from '@shared/schemas';
import type { TaskGroupLevelConfig } from './taskGroupLevel';

// Status icon mapping
const STATUS_ICONS: Record<string, string> = {
  [STREAM_STATUS.RUNNING]: 'sync spin',
  [STREAM_STATUS.ERROR]: 'error',
  [STREAM_STATUS.STOPPED]: 'check',
};

/**
 * Formats task group headers using Lit templates.
 */
export class TaskGroupHeaderFormatter {
  /** Create a group header element. */
  create(group: TaskGroup): HTMLElement | null {
    const startDate = new Date(group.startTime);
    const level = this._getGroupLevel(group);
    const formatter =
      level === TaskGroupLevel.ROOT
        ? getDateTimeFormatter()
        : getTimeFormatter();
    const formattedStartTime = level.formatTime(startDate, formatter);
    const iconClass = STATUS_ICONS[group.status] ?? 'circle-outline';
    const durationText = group.endTime
      ? formatDuration(group.endTime - group.startTime)
      : '';

    return renderToElement(html`
      <summary
        id=${`${GROUP_DOM_IDS.HEADER_PREFIX}${group.id}`}
        class=${classMap({
          'log-group-header': true,
          [`is-${group.status}`]: true,
          [level.cssClass ?? '']: Boolean(level.cssClass),
        })}
      >
        <span class="group-status-icon">
          <i class=${`codicon codicon-${iconClass}`}></i>
        </span>
        ${when(
          level.showTitle,
          () => html`<span class="group-title">${group.name}</span>`,
        )}
        <span class="group-time">
          <span class="group-start-time" data-start=${String(group.startTime)}>
            <i class="codicon codicon-clock"></i> ${formattedStartTime}
          </span>
          ${when(
            durationText,
            () => html`<span class="group-duration">${durationText}</span>`,
          )}
        </span>
      </summary>
    `);
  }

  _getGroupLevel(group: TaskGroup): TaskGroupLevelConfig {
    return group.parentGroupId ? TaskGroupLevel.NESTED : TaskGroupLevel.ROOT;
  }

  /** Get status icon template for DOM updates */
  _getStatusIcon(status: string): TemplateResult {
    const iconClass = STATUS_ICONS[status] ?? 'circle-outline';
    return html`<i class=${`codicon codicon-${iconClass}`}></i>`;
  }

  /** Get header class string for DOM updates */
  _getHeaderClass(group: TaskGroup, level: TaskGroupLevelConfig): string {
    const classes = ['log-group-header', `is-${group.status}`];
    if (level.cssClass) classes.push(level.cssClass);
    return classes.join(' ');
  }

  /** Format duration for DOM updates */
  _formatDuration(durationMs: number): string {
    return formatDuration(durationMs);
  }
}
