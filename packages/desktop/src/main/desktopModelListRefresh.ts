import { platform } from '@platform/platform';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { refreshModelListStateIfNeeded } from '@model/modelListRefresh';
import type { StateStore } from '@platform/interfaces/state';

export interface DesktopModelListRefreshOptions {
  globalState?: StateStore;
  onError?: (error: unknown) => void;
}

export async function refreshDesktopModelListStateIfNeeded({
  globalState = platform().globalState,
  onError,
}: DesktopModelListRefreshOptions = {}): Promise<void> {
  try {
    const result = await refreshModelListStateIfNeeded(globalState);
    if (result.added.length > 0 || result.removed.length > 0) {
      invalidateModelOptionsCache();
    }
  } catch (error) {
    onError?.(error);
  }
}
