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
 * Simplified implementation that stores usage per group and computes aggregates on-demand.
 */
export class UsageGroupManager {
  constructor(usageSummary, taskGroupDomManager) {
    this.usageSummary = usageSummary;
    this.taskGroups = taskGroupDomManager;
  }

  /**
   * Update token and cost usage for a specific group
   * @param {{ groupId: string, usage?: Object }} payload
   */
  update(payload) {
    if (!payload || typeof payload !== 'object') {
      console.error('UsageGroupManager.update: payload must be an object');
      return;
    }

    const { groupId, usage } = payload;
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

    // Store usage for this group
    if (usage) {
      const { inputTokens = 0, outputTokens = 0, cost = 0 } = usage;
      group.usage = { inputTokens, outputTokens, cost };
    } else {
      delete group.usage;
    }

    progressViewState.taskGroups.set(groupId, group);

    // Update all affected groups in a single pass
    this._updateAffectedGroups(groupId);

    // Refresh the cumulative summary
    this.usageSummary.update();
  }

  /**
   * Update the UI for this group and all its ancestors
   * @private
   */
  _updateAffectedGroups(groupId) {
    const group = progressViewState.taskGroups.get(groupId);
    if (!group) return;

    // Get all groups that need updating (this group and all ancestors)
    const groupsToUpdate = [groupId];
    let currentId = group.parentGroupId;
    while (currentId) {
      groupsToUpdate.push(currentId);
      const parent = progressViewState.taskGroups.get(currentId);
      currentId = parent?.parentGroupId;
    }

    // Update each group's display with its computed usage
    for (const id of groupsToUpdate) {
      const groupToUpdate = progressViewState.taskGroups.get(id);
      if (!groupToUpdate) continue;

      // Compute aggregated usage for this group (includes own + all descendants)
      const aggregatedUsage = this._computeGroupUsage(id);

      // Update the display with aggregated usage
      const treeItem = this.taskGroups?.groupElements?.get(id);
      if (treeItem instanceof HTMLElement) {
        // Temporarily set aggregated usage for rendering
        const originalUsage = groupToUpdate.usage;
        groupToUpdate.usage = aggregatedUsage;
        this.taskGroups.headerFormatter.render(treeItem, groupToUpdate);
        groupToUpdate.usage = originalUsage; // Restore original
      }
    }
  }

  /**
   * Compute total usage for a group and all its descendants
   * @private
   */
  _computeGroupUsage(groupId) {
    const totals = { inputTokens: 0, outputTokens: 0, cost: 0 };
    const group = progressViewState.taskGroups.get(groupId);

    // Add this group's usage
    if (group?.usage) {
      totals.inputTokens += group.usage.inputTokens || 0;
      totals.outputTokens += group.usage.outputTokens || 0;
      totals.cost += group.usage.cost || 0;
    }

    // Add all descendants' usage in a single pass
    const taskGroups = progressViewState.taskGroups.getGroupMap();
    const descendants = new Set();

    // Find all descendants
    const findDescendants = (parentId) => {
      for (const [id, g] of taskGroups.entries()) {
        if (g.parentGroupId === parentId && !descendants.has(id)) {
          descendants.add(id);
          findDescendants(id);
        }
      }
    };

    findDescendants(groupId);

    // Sum up usage from all descendants
    for (const descendantId of descendants) {
      const descendant = taskGroups.get(descendantId);
      if (descendant?.usage) {
        totals.inputTokens += descendant.usage.inputTokens || 0;
        totals.outputTokens += descendant.usage.outputTokens || 0;
        totals.cost += descendant.usage.cost || 0;
      }
    }

    return totals;
  }
}
