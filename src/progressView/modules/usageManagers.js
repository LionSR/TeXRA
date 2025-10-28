// Local imports - progress view
import { ELEMENT_IDS } from './constants.js';
// Local imports
import { progressViewState } from './progressViewState.js';

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
    const taskGroups = progressViewState.taskGroups.getGroupMap();
    for (const group of taskGroups.values()) {
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
export class UsageGroupManager {
  constructor(usageSummary, taskGroupDomManager) {
    this.usageSummary = usageSummary; // Use the shared instance
    this.taskGroups = taskGroupDomManager;
  }

  /**
   * Update token and cost usage for a specific group
   * @param {{ groupId: string, usage?: Object, skipPropagate?: boolean }} payload
   */
  update(payload) {
    if (!payload || typeof payload !== 'object') {
      console.error('UsageGroupManager.update: payload must be an object');
      return;
    }

    const { groupId, usage, skipPropagate = false } = payload;
    if (!groupId) {
      console.error('UsageGroupManager.update: groupId is required');
      return;
    }

    const group = progressViewState.taskGroups.get(groupId);
    if (!group) {
      console.warn(
        `UsageGroupManager.update: Group not found for ID: ${groupId}`,
      );
      return;
    }

    if (usage) {
      const { inputTokens = 0, outputTokens = 0, cost = 0 } = usage;
      group.usage = { inputTokens, outputTokens, cost };
    } else {
      delete group.usage;
    }

    progressViewState.taskGroups.set(groupId, group);

    const treeItem = this.taskGroups?.groupElements?.get(groupId);
    if (treeItem instanceof HTMLElement) {
      this.taskGroups.headerFormatter.render(treeItem, group);
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
    const totals = { inputTokens: 0, outputTokens: 0, cost: 0 };
    const taskGroups = progressViewState.taskGroups.getGroupMap();
    for (const group of taskGroups.values()) {
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
    const group = progressViewState.taskGroups.get(groupId);
    if (!group) return;

    // If this group has a parent, update the parent with aggregated usage
    if (group.parentGroupId) {
      const totals = this.computeAggregatedUsage(group.parentGroupId);
      this.update({
        groupId: group.parentGroupId,
        usage: totals,
        skipPropagate: true,
      });
      this.propagateUsageToParents(group.parentGroupId);
    } else {
      // This is a top-level group, update it with aggregated usage from its children
      const totals = this.computeAggregatedUsage(groupId);
      this.update({ groupId, usage: totals, skipPropagate: true });
    }
  }
}
