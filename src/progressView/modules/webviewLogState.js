// Local imports - state management helper
import { WebviewStateManager } from '@common/webviewState.js';

/**
 * Manages progress view state and handles persistence.
 */
export class WebviewLogState {
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
}

export const logState = new WebviewLogState();
