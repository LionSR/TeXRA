// Local imports - history view
import { WebviewStateManager } from '@common/webviewState.js';

class ToggleStates {
  constructor(saveCallback) {
    this.states = new Map();
    this.saveCallback = saveCallback;
  }

  set(id, expanded) {
    if (!id) return;
    this.states.set(id, expanded);
    if (this.saveCallback) this.saveCallback();
  }

  get(id) {
    return this.states.get(id);
  }

  entries() {
    return [...this.states.entries()];
  }

  load(data) {
    this.states = new Map(data);
  }

  clearAll() {
    this.states.clear();
    if (this.saveCallback) this.saveCallback();
  }
}

export class HistoryViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();
    this.searchIndex = 0;
    this.totalMatches = 0;
    this.toggleStates = new ToggleStates(() => this.save());
  }

  initialize() {
    const state = this.stateManager.getState();
    const saved = typeof state === 'object' && state !== null ? state : {};
    this.searchIndex = saved.searchIndex || 0;
    this.totalMatches = saved.totalMatches || 0;
    const { toggleStates } = saved;
    if (Array.isArray(toggleStates)) {
      this.toggleStates.load(toggleStates);
    } else if (typeof toggleStates === 'string') {
      try {
        const parsed = JSON.parse(toggleStates);
        if (Array.isArray(parsed)) {
          this.toggleStates.load(parsed);
          this.save();
        } else {
          console.error('Failed to restore toggle states: expected an array.');
        }
      } catch (e) {
        console.error('Failed to migrate toggle states from string.', e);
      }
    } else if (toggleStates !== undefined) {
      console.error('Failed to restore toggle states: expected an array.');
    }
  }

  save() {
    try {
      this.stateManager.update({
        searchIndex: this.searchIndex,
        totalMatches: this.totalMatches,
        toggleStates: this.toggleStates.entries(),
      });
    } catch (e) {
      console.error('Failed to save state', e);
    }
  }

  setSearchIndex(index) {
    this.searchIndex = index;
    this.save();
  }

  setTotalMatches(count) {
    this.totalMatches = count;
    this.save();
  }
}

export const historyViewState = new HistoryViewState();
