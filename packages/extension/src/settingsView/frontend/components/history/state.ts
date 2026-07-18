import { z } from 'zod';

// Local imports - shared state
import { hostBridge } from '@shared/hostBridge';
import {
  PersistedState,
  createWebviewStorage,
} from '@shared/state/PersistedState';
import { ToggleStateStore } from '@shared/state/ToggleStateStore';

const HistoryViewStateSchema = z.object({
  searchIndex: z.number().catch(0),
  totalMatches: z.number().catch(0),
  toggleStates: z.array(z.tuple([z.string(), z.boolean()])).catch([]),
});

type HistoryViewPersistedState = z.infer<typeof HistoryViewStateSchema>;

export class HistoryViewState {
  private readonly state = new PersistedState<HistoryViewPersistedState>(
    createWebviewStorage(hostBridge),
    'historyView',
    HistoryViewStateSchema,
  );
  public readonly toggleStates = new ToggleStateStore(() => this.save());
  public searchIndex = 0;
  public totalMatches = 0;

  initialize(): void {
    const saved = this.state.getState();
    this.searchIndex = saved.searchIndex;
    this.totalMatches = saved.totalMatches;
    this.toggleStates.load(saved.toggleStates);
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
    this.state.update({
      searchIndex: this.searchIndex,
      totalMatches: this.totalMatches,
      toggleStates: this.toggleStates.entries(),
    });
  }
}
