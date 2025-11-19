// Local imports - history view
import { WebviewStateManager } from '@common/webviewState.js';

const restoreToggleStates = (savedState) =>
  Array.isArray(savedState.toggleStates) ? savedState.toggleStates : [];

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
    const restoredToggleStates = restoreToggleStates(saved);
    if (restoredToggleStates.length > 0) {
      this.toggleStates.load(restoredToggleStates);
    }
  }

  save() {
    this.stateManager.update({
      searchIndex: this.searchIndex,
      totalMatches: this.totalMatches,
      toggleStates: this.toggleStates.entries(),
    });
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
