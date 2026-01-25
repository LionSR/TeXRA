// Local imports - shared state
import { ToggleStateStore } from '@shared/state/ToggleStateStore';
import { WebviewStateManager } from '@shared/state/WebviewStateManager';

export interface HistoryViewPersistedState extends Record<string, unknown> {
  searchIndex?: number;
  totalMatches?: number;
  toggleStates?: Array<[string, boolean]>;
}

export class HistoryViewState {
  private readonly stateManager =
    new WebviewStateManager<HistoryViewPersistedState>();
  public readonly toggleStates = new ToggleStateStore(() => this.save());
  public searchIndex = 0;
  public totalMatches = 0;

  initialize(): void {
    const saved = this.stateManager.getState();
    this.searchIndex = saved.searchIndex ?? 0;
    this.totalMatches = saved.totalMatches ?? 0;
    if (Array.isArray(saved.toggleStates)) {
      this.toggleStates.load(saved.toggleStates);
    }
  }

  setSearchIndex(index: number): void {
    this.searchIndex = index;
    this.save();
  }

  setTotalMatches(count: number): void {
    this.totalMatches = count;
    this.save();
  }

  save(): void {
    this.stateManager.update({
      searchIndex: this.searchIndex,
      totalMatches: this.totalMatches,
      toggleStates: this.toggleStates.entries(),
    });
  }
}
