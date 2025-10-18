// Local imports - progress view
import { ELEMENT_IDS } from './constants.js';
import { formatTokens, TaskGroupLevel } from './formatters.js';
// Local imports
import { progressViewState } from './progressViewState.js';
import { createFromTemplate } from '@common/templateUtils.js';

/**
 * Manages usage summary display.
 */
export class UsageSummary {
  constructor() {
    this._summaryElem = null;
  }

  /**
   * Update token and cost summary in the header by aggregating usage from
   * "Round" groups. Falls back to the provided usage if given.
   * @param {Object} [usage] - Optional pre-computed usage totals
   */
  update(usage) {
    // Cache the summary element
    if (!this._summaryElem) {
      this._summaryElem = document.getElementById(ELEMENT_IDS.RUN_SUMMARY);
    }
    if (!this._summaryElem) return;
    // If usage is not provided, compute it from existing log groups
    const totals = usage ?? this.computeTotal();

    // Clear the summary - we're showing total usage in the files section now
    this._summaryElem.textContent = '';
  }

  /**
   * Compute total usage from all groups
   * @returns {Object} Total usage with inputTokens, outputTokens, and cost
   */
  computeTotal() {
    const totals = { inputTokens: 0, outputTokens: 0, cost: 0 };
    for (const group of progressViewState.taskGroups.getAll().values()) {
      if (group.usage) {
        totals.inputTokens += group.usage.inputTokens || 0;
        totals.outputTokens += group.usage.outputTokens || 0;
        totals.cost += group.usage.cost || 0;
      }
    }
    return totals;
  }
}

/**
 * Manages usage display for individual groups.
 */
export class UsageGroup {
  constructor(usageSummary) {
    this.usageSummary = usageSummary; // Use the shared instance
  }

  /**
   * Update token and cost usage for a specific group
   * @param {string} groupId - ID of the group to update
   * @param {Object} usage - Usage data with inputTokens, outputTokens, cost
   * @param {boolean} skipPropagate - Whether to skip propagating to parents
   */
  update(groupId, usage, skipPropagate = false) {
    if (!groupId) {
      console.error('UsageGroup.update: groupId is required');
      return;
    }

    const groupHeader = document.getElementById(`group-header-${groupId}`);
    if (!groupHeader) {
      console.warn(
        `UsageGroup.update: Group header not found for ID: ${groupId}`,
      );
      return;
    }

    // Find or create usage display element in the group header
    let usageElem = groupHeader.querySelector('.group-usage');
    if (!usageElem) {
      usageElem = createFromTemplate('usageTemplate');
      if (!usageElem) {
        console.error('UsageGroup.update: usageTemplate not found');
        return;
      }
      // Determine the group level by checking for the 'top-level' class
      const level = groupHeader.classList.contains('top-level')
        ? TaskGroupLevel.ROOT
        : TaskGroupLevel.NESTED;
      this.insertUsageElement(groupHeader, usageElem, level);
    }

    if (!usageElem) return;

    const inputEl = usageElem.querySelector('.usage-input');
    const outputEl = usageElem.querySelector('.usage-output');
    const costEl = usageElem.querySelector('.usage-cost');

    if (!usage) {
      if (inputEl) inputEl.textContent = '';
      if (outputEl) outputEl.textContent = '';
      if (costEl) costEl.textContent = '';
      return;
    }

    const { inputTokens = 0, outputTokens = 0, cost = 0 } = usage;
    if (inputEl) inputEl.textContent = formatTokens(inputTokens);
    if (outputEl) outputEl.textContent = formatTokens(outputTokens);
    if (costEl) costEl.textContent = cost.toFixed(3);

    // Persist usage on the group state so the summary can be computed
    const activeStream = progressViewState.activeStream;
    const group = progressViewState.taskGroups.get(activeStream, groupId);
    if (group) {
      group.usage = { inputTokens, outputTokens, cost };
      progressViewState.taskGroups.set(activeStream, groupId, group);
    }
    if (!skipPropagate) {
      this.propagateUsageToParents(groupId);
    }

    // Refresh the cumulative summary displayed in the header
    this.usageSummary.update();
  }

  /**
   * Compute aggregated usage for all children of a parent group
   * @private
   */
  computeAggregatedUsage(parentId) {
    const activeStream = progressViewState.activeStream;
    const totals = { inputTokens: 0, outputTokens: 0, cost: 0 };
    for (const group of progressViewState.taskGroups
      .getStreamGroups(activeStream)
      .values()) {
      if (group.parentGroupId === parentId) {
        if (group.usage) {
          totals.inputTokens += group.usage.inputTokens || 0;
          totals.outputTokens += group.usage.outputTokens || 0;
          totals.cost += group.usage.cost || 0;
        }
        const childTotals = this.computeAggregatedUsage(group.id);
        totals.inputTokens += childTotals.inputTokens;
        totals.outputTokens += childTotals.outputTokens;
        totals.cost += childTotals.cost;
      }
    }
    return totals;
  }

  /**
   * Propagate usage updates to parent groups
   * @private
   */
  propagateUsageToParents(groupId) {
    const activeStream = progressViewState.activeStream;
    const group = progressViewState.taskGroups.get(activeStream, groupId);
    if (!group) return;

    // If this group has a parent, update the parent with aggregated usage
    if (group.parentGroupId) {
      const totals = {
        ...this.computeAggregatedUsage(group.parentGroupId),
      };
      this.update(group.parentGroupId, totals, true);
      this.propagateUsageToParents(group.parentGroupId);
    } else {
      // This is a top-level group, update it with aggregated usage from its children
      const totals = {
        ...this.computeAggregatedUsage(groupId),
      };
      this.update(groupId, totals, true);
    }
  }

  /**
   * Determines where to insert a usage element based on group level and existing elements
   * @private
   * @param {HTMLElement} groupHeader - The group header element
   * @param {HTMLElement} usageElem - The usage element to insert
   * @param {Object} level - The task group level configuration
   */
  insertUsageElement(groupHeader, usageElem, level) {
    const timeContainer = groupHeader.querySelector('.group-time');

    let bulletElem = groupHeader.querySelector('.group-bullet');
    if (!bulletElem) {
      bulletElem = createFromTemplate('bulletTemplate');
    }

    // If bullet template is missing, skip adding it
    const hasBullet = !!bulletElem;

    if (timeContainer) {
      if (level.headerOrder === 'time-first') {
        // For root level groups: time comes first, then usage
        if (hasBullet) {
          timeContainer.parentNode.insertBefore(
            bulletElem,
            timeContainer.nextSibling,
          );
        }
        timeContainer.parentNode.insertBefore(
          usageElem,
          hasBullet ? bulletElem.nextSibling : timeContainer.nextSibling,
        );
      } else {
        // For nested groups: usage comes first, then time
        groupHeader.insertBefore(usageElem, timeContainer);
        if (hasBullet) {
          groupHeader.insertBefore(bulletElem, timeContainer);
        }
      }
    } else {
      groupHeader.appendChild(usageElem);
      if (hasBullet) {
        groupHeader.appendChild(bulletElem);
      }
    }
  }
}
