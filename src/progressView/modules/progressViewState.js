// Local imports - progress view
// Local imports - state management helper
import { WebviewStateManager } from '@common/webviewState.js';

/**
 * Manages task groups in the progress view.
 */
class TaskGroups {
  constructor(getActiveStream) {
    this._groupsByStream = new Map();
    this._getActiveStream = getActiveStream;
  }

  _resolveStream(stream) {
    const resolved =
      stream ||
      (typeof this._getActiveStream === 'function'
        ? this._getActiveStream()
        : undefined);
    if (!resolved) {
      console.error('TaskGroups: stream id is required');
      return null;
    }
    return resolved;
  }

  _getStreamMap(stream, { create = true } = {}) {
    const resolved = this._resolveStream(stream);
    if (!resolved) {
      return null;
    }

    if (!this._groupsByStream.has(resolved)) {
      if (!create) {
        return null;
      }
      this._groupsByStream.set(resolved, new Map());
    }

    return this._groupsByStream.get(resolved) || null;
  }

  get(streamOrId, maybeId) {
    let stream = streamOrId;
    let id = maybeId;
    // If only one argument provided, treat it as id (old signature)
    if (arguments.length === 1) {
      id = streamOrId;
      stream = undefined;
    }
    if (!id) {
      console.error('TaskGroups.get: id is required');
      return null;
    }
    const map = this._getStreamMap(stream, { create: false });
    return map ? map.get(id) || null : null;
  }

  set(streamOrId, maybeId, maybeGroup) {
    let stream = streamOrId;
    let id = maybeId;
    let group = maybeGroup;
    // If only two arguments provided, treat as (id, group) - old signature
    if (arguments.length === 2) {
      group = maybeId;
      id = streamOrId;
      stream = undefined;
    }
    if (!id) {
      console.error('TaskGroups.set: id is required');
      return;
    }
    if (!group || typeof group !== 'object') {
      console.error('TaskGroups.set: group must be an object');
      return;
    }
    const map = this._getStreamMap(stream, { create: true });
    if (map) {
      map.set(id, group);
    }
  }

  getAll(stream) {
    const map = this._getStreamMap(stream, { create: false });
    return map ? new Map(map) : new Map();
  }

  getStreamGroups(stream) {
    const map = this._getStreamMap(stream, { create: false });
    return map ? map : new Map();
  }

  clear(stream) {
    if (stream !== undefined && stream !== null) {
      const resolved = this._resolveStream(stream);
      if (resolved) {
        this._groupsByStream.delete(resolved);
      }
      return;
    }
    this._groupsByStream.clear();
  }

  /**
   * Update an existing log group with new status or end time.
   * Supports two signatures:
   * - update(streamId, groupId, status, endTime) - new signature with stream
   * - update(groupId, status, endTime) - old signature without stream
   * @param {string} streamId - Stream identifier for the group (or groupId if 3 args)
   * @param {string} groupId - ID of the group to update (or status if 3 args)
   * @param {string} status - New status (or endTime if 3 args)
   * @param {number} [endTime] - Optional end time
   */
  update(streamOrGroupId, maybeGroupId, status, endTime) {
    let streamId = streamOrGroupId;
    let groupId = maybeGroupId;
    // Use argument count to distinguish between signatures
    if (arguments.length === 3 || arguments.length === 2) {
      // Old signature: update(groupId, status, endTime)
      endTime = status;
      status = maybeGroupId;
      groupId = streamOrGroupId;
      streamId = undefined;
    }
    // Otherwise: new signature update(streamId, groupId, status, endTime)

    if (!groupId) {
      console.error('TaskGroups.update: groupId is required');
      return;
    }
    const map = this._getStreamMap(streamId, { create: false });
    if (!map) {
      return;
    }
    const group = map.get(groupId);
    if (!group) {
      console.error(
        `TaskGroups.update: group not found for id ${groupId} in stream ${streamId}`,
      );
      return;
    }

    if (status) {
      group.status = status;
    }
    if (endTime !== undefined && endTime !== null) {
      group.endTime = endTime;
    }

    map.set(groupId, group);
  }

  getLatestRootGroupId(streamId) {
    const map = this._getStreamMap(streamId, { create: false });
    if (!map) {
      return null;
    }
    let latest = null;
    for (const group of map.values()) {
      if (group && !group.parentGroupId) {
        if (!latest) {
          latest = group;
          continue;
        }
        const groupTime =
          typeof group.startTime === 'number' ? group.startTime : 0;
        const latestTime =
          typeof latest.startTime === 'number' ? latest.startTime : 0;
        if (groupTime >= latestTime) {
          latest = group;
        }
      }
    }
    return latest?.id || null;
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
    this.currentGroupIds = new Map();
    this.selectedGroups = new Map();

    // Initialize managers
    this.taskGroups = new TaskGroups(() => this.activeStream);
    this.toggleStates = new ToggleStates(() => this.save());
    this.streamStatuses = new StreamStatuses();
    this.executionAvailability = new ExecutionAvailability();
  }

  setSelectedGroup(stream, groupId) {
    if (!stream) {
      return;
    }
    if (groupId) {
      this.selectedGroups.set(stream, groupId);
      this.currentGroupIds.set(stream, groupId);
    } else {
      this.selectedGroups.delete(stream);
      this.currentGroupIds.delete(stream);
    }
  }

  getSelectedGroup(stream) {
    if (!stream) {
      return null;
    }
    return this.selectedGroups.get(stream) || null;
  }

  setCurrentGroup(stream, groupId) {
    if (!stream) {
      return;
    }
    if (groupId) {
      this.currentGroupIds.set(stream, groupId);
    } else {
      this.currentGroupIds.delete(stream);
    }
  }

  getCurrentGroup(stream) {
    if (!stream) {
      return null;
    }
    return this.currentGroupIds.get(stream) || null;
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
