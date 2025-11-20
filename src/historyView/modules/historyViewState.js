// Local imports - history view
import { WebviewStateManager } from '@common/webviewState.js';

const restoreToggleStates = (savedState) =>
  Array.isArray(savedState.toggleStates)
    ? Object.fromEntries(savedState.toggleStates)
    : {};

const createToggleStateStore = (saveCallback) => {
  let states = {};

  return {
    set(id, expanded) {
      if (!id) return;
      states = { ...states, [id]: expanded };
      if (saveCallback) saveCallback();
    },
    get(id) {
      return states[id];
    },
    entries() {
      return Object.entries(states);
    },
    load(data) {
      states = { ...data };
    },
    clearAll() {
      states = {};
      if (saveCallback) saveCallback();
    },
  };
};

export class HistoryViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();
    this.searchIndex = 0;
    this.totalMatches = 0;
    this.toggleStates = createToggleStateStore(() => this.save());
  }

  initialize() {
    const state = this.stateManager.getState();
    const saved = typeof state === 'object' && state !== null ? state : {};
    this.searchIndex = saved.searchIndex || 0;
    this.totalMatches = saved.totalMatches || 0;
    const restoredToggleStates = restoreToggleStates(saved);
    this.toggleStates.load(restoredToggleStates);
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
