// Local imports - progress view
// Local imports - state management helper
import { WebviewStateManager } from '@common/webviewState.js';

/**
 * Manages task groups in the progress view.
 */
class TaskGroups {
  constructor() {
    this.groups = new Map();
    this._cachedTotals = null;
  }

  get(id) {
    if (!id) {
      console.error('TaskGroups.get: id is required');
      return null;
    }
    return this.groups.get(id);
  }

  set(id, group) {
    if (!id) {
      console.error('TaskGroups.set: id is required');
      return;
    }
    if (!group || typeof group !== 'object') {
      console.error('TaskGroups.set: group must be an object');
      return;
    }
    this.groups.set(id, group);
    this._cachedTotals = null; // Invalidate cache
  }

  getAll() {
    return this.groups;
  }

  clear() {
    this.groups.clear();
    this._cachedTotals = null; // Invalidate cache
  }

  /**
   * Update an existing log group with new status or end time.
   * @param {string} groupId - ID of the group to update
   * @param {string} status - New status
   * @param {number} [endTime] - Optional end time
   */
  update(groupId, status, endTime) {
    if (!groupId) {
      console.error('TaskGroups.update: groupId is required');
      return;
    }
    const group = this.groups.get(groupId);
    if (!group) {
      console.error(`TaskGroups.update: group not found for id ${groupId}`);
      return;
    }

    if (status) {
      group.status = status;
    }
    if (endTime !== undefined && endTime !== null) {
      group.endTime = endTime;
    }

    this.groups.set(groupId, group);
    this._cachedTotals = null; // Invalidate cache
  }
}

/**
 * Manages group toggle states with persistence.
 */
class ToggleStates {
  constructor(saveCallback) {
    this.states = new Map();
    this.saveCallback = saveCallback;
  }

  set(id, collapsed) {
    if (!id) {
      console.error('ToggleStates.set: id is required');
      return;
    }
    if (typeof collapsed !== 'boolean') {
      console.error('ToggleStates.set: collapsed must be a boolean');
      return;
    }
    this.states.set(id, collapsed);
    if (this.saveCallback) {
      this.saveCallback();
    }
  }

  get(id) {
    return this.states.get(id);
  }

  clear(ids) {
    if (!Array.isArray(ids)) {
      console.error('ToggleStates.clear: ids must be an array');
      return;
    }
    ids.forEach((id) => {
      if (id) {
        this.states.delete(id);
      }
    });
    if (this.saveCallback) {
      this.saveCallback();
    }
  }

  clearAll() {
    this.states.clear();
    if (this.saveCallback) {
      this.saveCallback();
    }
  }

  /** Get all entries for serialization */
  entries() {
    return [...this.states.entries()];
  }

  /** Load from serialized data */
  load(data) {
    this.states = new Map(data);
  }
}

/**
 * Manages stream status information.
 */
class StreamStatuses {
  constructor() {
    this.statuses = new Map();
  }

  get(stream) {
    return this.statuses.get(stream);
  }

  set(stream, status) {
    if (!stream) {
      console.error('StreamStatuses.set: stream is required');
      return;
    }
    if (!status) {
      console.error('StreamStatuses.set: status is required');
      return;
    }
    if (typeof status !== 'string') {
      console.error('StreamStatuses.set: status must be a string');
      return;
    }
    if (status !== 'ready') {
      this.statuses.set(stream, status);
    }
  }

  delete(stream) {
    this.statuses.delete(stream);
  }
}

/**
 * Tracks whether a stream has an execution directory available.
 */
class ExecutionAvailability {
  constructor() {
    this.availability = new Map();
  }

  set(stream, available) {
    if (!stream) {
      console.error('ExecutionAvailability.set: stream is required');
      return;
    }
    this.availability.set(stream, Boolean(available));
  }

  get(stream) {
    return this.availability.get(stream) ?? false;
  }

  delete(stream) {
    if (!stream) {
      return;
    }
    this.availability.delete(stream);
  }

  clear() {
    this.availability.clear();
  }
}

/**
 * Manages progress view state and handles persistence.
 */
export class ProgressViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();
    this.activeStream = '';
    this.agentFilter = 'all';
    this.currentGroupId = null;

    // Initialize managers
    this.taskGroups = new TaskGroups();
    this.toggleStates = new ToggleStates(() => this.save());
    this.streamStatuses = new StreamStatuses();
    this.executionAvailability = new ExecutionAvailability();
  }

  setExecutionAvailability(stream, available) {
    this.executionAvailability.set(stream, available);
  }

  getExecutionAvailability(stream) {
    return this.executionAvailability.get(stream);
  }

  clearExecutionAvailability(stream) {
    this.executionAvailability.delete(stream);
  }

  resetExecutionAvailability() {
    this.executionAvailability.clear();
  }

  /** Load saved state from VS Code storage. */
  initialize() {
    const previous = this.stateManager.getState();
    if (previous.groupToggleStates) {
      let data = previous.groupToggleStates;
      if (!Array.isArray(data) && typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) {
            data = parsed;
          } else {
            console.error(
              'Failed to restore group toggle states: parsed data is not an array',
            );
            return;
          }
        } catch (error) {
          console.error(
            'Failed to restore group toggle states: could not parse legacy string data',
            error,
          );
          return;
        }
      }

      if (!Array.isArray(data)) {
        console.error(
          'Failed to restore group toggle states: data is not an array',
        );
        return;
      }

      const hasValidEntries = data.every((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) {
          return false;
        }
        const [id, collapsed] = entry;
        return typeof id === 'string' && typeof collapsed === 'boolean';
      });

      if (!hasValidEntries) {
        console.error(
          'Failed to restore group toggle states: invalid entry format',
        );
        return;
      }

      this.toggleStates.load(data);
    }
  }

  /** Persist the current group toggle states. */
  save() {
    try {
      this.stateManager.update({
        groupToggleStates: this.toggleStates.entries(),
      });
    } catch (e) {
      console.error('Failed to save state:', e);
    }
  }
}

export const progressViewState = new ProgressViewState();
