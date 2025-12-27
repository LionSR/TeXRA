/**
 * Task group header formatter for progress view.
 */

import { createFromTemplate } from '@common/templateUtils.js';
import { STREAM_STATUS, GROUP_DOM_IDS } from '../constants.js';
import { TaskGroupLevel } from './taskGroupLevel.js';
import {
  getDateTimeFormatter,
  getTimeFormatter,
  formatDuration,
} from './timestampUtils.js';

/**
 * Formats task group headers.
 */
export class TaskGroupHeaderFormatter {
  /**
   * Create a group header element
   * @param {Object} group - Task group data
   * @returns {HTMLElement|null} Header element or null if template creation fails
   */
  create(group) {
    const startDate = new Date(group.startTime);
    const level = this._getGroupLevel(group);
    const formatter =
      level === TaskGroupLevel.ROOT
        ? getDateTimeFormatter()
        : getTimeFormatter();
    const formattedStartTime = level.formatTime(startDate, formatter);

    const header = createFromTemplate('groupHeaderTemplate');
    if (!header) return null;

    header.id = `${GROUP_DOM_IDS.HEADER_PREFIX}${group.id}`;
    header.className = this._getHeaderClass(group, level);

    const statusIconElem = header.querySelector('.group-status-icon');
    if (statusIconElem) {
      statusIconElem.innerHTML = this._getStatusIcon(group.status);
    }

    const titleElem = header.querySelector('.group-title');
    if (titleElem) {
      if (level.showTitle) {
        titleElem.textContent = group.name;
      } else {
        titleElem.remove();
      }
    }

    const startTimeElem = header.querySelector('.group-start-time');
    if (startTimeElem) {
      startTimeElem.dataset.start = String(group.startTime);
      startTimeElem.innerHTML = `<i class="codicon codicon-clock"></i> ${formattedStartTime}`;
    }

    const durationElem = header.querySelector('.group-duration');
    if (durationElem) {
      if (group.endTime) {
        const durationMs = group.endTime - group.startTime;
        durationElem.textContent = formatDuration(durationMs);
      } else {
        durationElem.remove();
      }
    }

    return header;
  }

  _getGroupLevel(group) {
    return group.parentGroupId ? TaskGroupLevel.NESTED : TaskGroupLevel.ROOT;
  }

  _getHeaderClass(group, level) {
    const classes = ['log-group-header', `is-${group.status}`];
    if (level.cssClass) {
      classes.push(level.cssClass);
    }
    return classes.join(' ');
  }

  _getStatusIcon(status) {
    switch (status) {
      case STREAM_STATUS.RUNNING:
        return '<i class="codicon codicon-sync spin"></i>';
      case STREAM_STATUS.ERROR:
        return '<i class="codicon codicon-error"></i>';
      case STREAM_STATUS.STOPPED:
        return '<i class="codicon codicon-check"></i>';
      default:
        return '<i class="codicon codicon-circle-outline"></i>';
    }
  }

  /**
   * Format duration in milliseconds to human-readable string.
   * Exposed as instance method for external callers (e.g., taskManagers.js).
   * @param {number} durationMs - Duration in milliseconds
   * @returns {string} Formatted duration string
   */
  _formatDuration(durationMs) {
    return formatDuration(durationMs);
  }
}
