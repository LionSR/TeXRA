// Local imports - state management helper
import { WebviewStateManager } from '@common/webviewState.js';

/**
 * Manages progress view state and handles persistence.
 */
export class ProgressViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();
    this.currentStream = '';
    this.streamStatuses = new Map();
    this.logGroups = new Map();
    this.groupToggleStates = new Map();
  }

  /** Load saved state from VS Code storage. */
  initialize() {
    const previous = this.stateManager.getState();
    if (previous.groupToggleStates) {
      try {
        this.groupToggleStates = new Map(
          JSON.parse(previous.groupToggleStates),
        );
      } catch (e) {
        console.error('Failed to restore group toggle states:', e);
      }
    }
  }

  /** Persist the current group toggle states. */
  save() {
    try {
      const serialized = JSON.stringify([...this.groupToggleStates.entries()]);
      this.stateManager.update({ groupToggleStates: serialized });
    } catch (e) {
      console.error('Failed to save state:', e);
    }
  }

  // --- stream operations ---
  getCurrentStream() {
    return this.currentStream;
  }

  setCurrentStream(stream) {
    this.currentStream = stream;
  }

  getStreamStatus(stream) {
    return this.streamStatuses.get(stream);
  }

  setStreamStatus(stream, status) {
    if (stream && status !== 'ready') {
      this.streamStatuses.set(stream, status);
    }
  }

  deleteStreamStatus(stream) {
    this.streamStatuses.delete(stream);
  }

  // --- group operations ---
  getLogGroup(id) {
    return this.logGroups.get(id);
  }

  setLogGroup(id, group) {
    this.logGroups.set(id, group);
  }

  getLogGroups() {
    return this.logGroups;
  }

  clearLogGroups() {
    this.logGroups.clear();
  }

  setGroupToggleState(id, collapsed) {
    this.groupToggleStates.set(id, collapsed);
    this.save();
  }

  getGroupToggleState(id) {
    return this.groupToggleStates.get(id);
  }

  clearGroupToggleStates(ids) {
    ids.forEach((id) => this.groupToggleStates.delete(id));
    this.save();
  }

  clearAllGroupToggleStates() {
    this.groupToggleStates.clear();
    this.save();
  }
  /**
   * Update an existing log group with new status or end time.
   * @param {string} groupId - ID of the group to update
   * @param {string} status - New status
   * @param {number} [endTime] - Optional end time
   */
  updateLogGroup(groupId, status, endTime) {
    const group = this.logGroups.get(groupId);
    if (!group) return;

    group.status = status;
    if (endTime) {
      group.endTime = endTime;
    }

    this.logGroups.set(groupId, group);
  }
}

export const progressViewState = new ProgressViewState();
