// Local imports - history view
import { WebviewStateManager } from '@common/webviewState.js';
import { ToggleStateStore } from '@common/ToggleStateStore.js';

export class HistoryViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();
    this.searchIndex = 0;
    this.totalMatches = 0;
    this.toggleStates = new ToggleStateStore(this.save.bind(this));
  }

  initialize() {
    const saved = this.stateManager.getState();
    this.searchIndex = saved.searchIndex || 0;
    this.totalMatches = saved.totalMatches || 0;
    if (Array.isArray(saved.toggleStates)) {
      this.toggleStates.load(saved.toggleStates);
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
