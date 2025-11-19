// Local imports - history view
import { WebviewStateManager } from '@common/webviewState.js';

export class HistoryViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();
    this.searchIndex = 0;
    this.totalMatches = 0;
    this.toggleStates = {};
  }

  initialize() {
    const state = this.stateManager.getState();
    const saved = typeof state === 'object' && state !== null ? state : {};
    this.searchIndex = saved.searchIndex || 0;
    this.totalMatches = saved.totalMatches || 0;
    const restored =
      typeof saved.toggleStates === 'object' && saved.toggleStates !== null
        ? saved.toggleStates
        : {};
    this.toggleStates = restored;
  }

  save() {
    this.stateManager.update({
      searchIndex: this.searchIndex,
      totalMatches: this.totalMatches,
      toggleStates: this.toggleStates,
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

  setToggleState(id, expanded) {
    if (!id) return;
    this.toggleStates[id] = expanded;
    this.save();
  }

  getToggleState(id) {
    return this.toggleStates[id];
  }

  clearToggleStates() {
    this.toggleStates = {};
    this.save();
  }
}

export const historyViewState = new HistoryViewState();
