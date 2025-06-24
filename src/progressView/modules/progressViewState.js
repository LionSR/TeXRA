// Local imports - state management helper
import { WebviewStateManager } from '@common/webviewState.js';

/**
 * Manages log groups in the progress view.
 */
class LogGroups {
  constructor() {
    this.groups = new Map();
  }

  get(id) {
    return this.groups.get(id);
  }

  set(id, group) {
    this.groups.set(id, group);
  }

  getAll() {
    return this.groups;
  }

  clear() {
    this.groups.clear();
  }

  /**
   * Update an existing log group with new status or end time.
   * @param {string} groupId - ID of the group to update
   * @param {string} status - New status
   * @param {number} [endTime] - Optional end time
   */
  update(groupId, status, endTime) {
    const group = this.groups.get(groupId);
    if (!group) return;

    group.status = status;
    if (endTime) {
      group.endTime = endTime;
    }

    this.groups.set(groupId, group);
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
    this.states.set(id, collapsed);
    this.saveCallback();
  }

  get(id) {
    return this.states.get(id);
  }

  clear(ids) {
    ids.forEach((id) => this.states.delete(id));
    this.saveCallback();
  }

  clearAll() {
    this.states.clear();
    this.saveCallback();
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
    if (stream && status !== 'ready') {
      this.statuses.set(stream, status);
    }
  }

  delete(stream) {
    this.statuses.delete(stream);
  }
}

/**
 * Manages progress view state and handles persistence.
 */
export class ProgressViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();
    this.currentStream = '';

    // Initialize managers
    this.logGroups = new LogGroups();
    this.toggleStates = new ToggleStates(() => this.save());
    this.streamStatuses = new StreamStatuses();
  }

  /** Load saved state from VS Code storage. */
  initialize() {
    const previous = this.stateManager.getState();
    if (previous.groupToggleStates) {
      try {
        const data = JSON.parse(previous.groupToggleStates);
        this.toggleStates.load(data);
      } catch (e) {
        console.error('Failed to restore group toggle states:', e);
      }
    }
  }

  /** Persist the current group toggle states. */
  save() {
    try {
      const serialized = JSON.stringify(this.toggleStates.entries());
      this.stateManager.update({ groupToggleStates: serialized });
    } catch (e) {
      console.error('Failed to save state:', e);
    }
  }

  // --- Current stream operations ---
  getCurrentStream() {
    return this.currentStream;
  }

  setCurrentStream(stream) {
    this.currentStream = stream;
  }
}

export const progressViewState = new ProgressViewState();
