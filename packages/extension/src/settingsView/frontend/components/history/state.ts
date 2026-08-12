import { z } from 'zod';

// Local imports - shared state
import { hostBridge } from '@shared/hostBridge';
import {
  PersistedState,
  createWebviewStorage,
} from '@shared/state/PersistedState';
import { ToggleStateStore } from '@shared/state/ToggleStateStore';

/**
 * Only the expand/collapse state survives a reload. Search position is not
 * persisted: the search term itself never was, so a restored "3/7" described
 * a search the user could no longer see.
 */
const HistoryViewStateSchema = z.object({
  toggleStates: z.array(z.tuple([z.string(), z.boolean()])).prefault([]),
});

type HistoryViewPersistedState = z.infer<typeof HistoryViewStateSchema>;

export class HistoryViewState {
  private readonly state = new PersistedState<HistoryViewPersistedState>(
    createWebviewStorage(hostBridge),
    'historyView',
    HistoryViewStateSchema,
  );
  public readonly toggleStates = new ToggleStateStore(() => this.save());

  initialize(): void {
    this.toggleStates.load(this.state.getState().toggleStates);
  }

  save(): void {
    this.state.update({ toggleStates: this.toggleStates.entries() });
  }
}
