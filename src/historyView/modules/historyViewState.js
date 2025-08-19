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
    const saved = this.stateManager.getState();
    this.searchIndex = saved.searchIndex || 0;
    this.totalMatches = saved.totalMatches || 0;
    if (saved.toggleStates) {
      try {
        const data = JSON.parse(saved.toggleStates);
        this.toggleStates.load(data);
      } catch (e) {
        console.error('Failed to restore toggle states', e);
      }
    }
  }

  save() {
    try {
      const serialized = JSON.stringify(this.toggleStates.entries());
      this.stateManager.update({
        searchIndex: this.searchIndex,
        totalMatches: this.totalMatches,
        toggleStates: serialized,
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
