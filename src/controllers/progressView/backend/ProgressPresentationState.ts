import { z } from 'zod';

// Local imports - platform
import type { StateStore } from '@platform/interfaces';
// Local imports - shared
import { StreamTabIdSchema, type StreamTabId } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  PersistedState,
  createBackendStorage,
} from '@shared/state/PersistedState';

/** Selected progress-view stream, or an empty string when none is selected. */
type ActiveProgressStream = StreamTabId | '';

const ProgressPresentationPrefsSchema = z.object({
  activeStream: z
    .union([StreamTabIdSchema, z.literal('')])
    .prefault('') as z.ZodType<ActiveProgressStream>,
});

type ProgressPresentationPrefs = z.infer<
  typeof ProgressPresentationPrefsSchema
>;

/**
 * Persisted choices belonging to the progress presentation.
 *
 * This state is deliberately separate from the session: selecting a tab does
 * not change a run, transcript, or execution. The existing workspace key is
 * retained so upgrades preserve the user's last selected tab without a
 * migration or a second persisted representation.
 */
export class ProgressPresentationState {
  private readonly prefs: PersistedState<ProgressPresentationPrefs>;

  constructor(storage: StateStore) {
    this.prefs = new PersistedState(
      createBackendStorage(storage),
      WorkspaceStateKey.PROGRESS_VIEW_PREFS,
      ProgressPresentationPrefsSchema,
    );
  }

  get activeStream(): ActiveProgressStream {
    return this.prefs.get('activeStream');
  }

  /** Persist one confirmed selection. Pending UI intent never enters here. */
  select(stream: ActiveProgressStream): void {
    if (this.activeStream === stream) return;
    this.prefs.update({ activeStream: stream });
  }

  /**
   * Keep the saved selection when it remains available; otherwise choose the
   * first stream in the presentation's already-ordered roster.
   */
  choose(availableStreams: readonly StreamTabId[]): ActiveProgressStream {
    const current = this.activeStream;
    return availableStreams.includes(current)
      ? current
      : (availableStreams[0] ?? '');
  }

  reload(): void {
    this.prefs.reload();
  }

  reset(): void {
    this.prefs.reset();
  }
}
