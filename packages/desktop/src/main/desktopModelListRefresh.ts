import * as logger from '@logger/logUtils';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { refreshModelListStateIfNeeded } from '@model/modelListRefresh';
import { platform } from '@platform/platform';
import type { StateStore } from '@platform/interfaces';
import { toErrorMessage } from '@utils/errors/errorMessage';

export interface DesktopModelListRefreshOptions {
  globalState?: StateStore;
}

export async function refreshDesktopModelListStateIfNeeded({
  globalState = platform().globalState,
}: DesktopModelListRefreshOptions = {}): Promise<void> {
  try {
    const { added, removed } = await refreshModelListStateIfNeeded(globalState);
    if (added.length > 0 || removed.length > 0) {
      invalidateModelOptionsCache();
      logger.info(
        'desktop',
        `Refreshed enabled models: added [${added.join(', ')}], removed [${removed.join(', ')}]`,
      );
    }
  } catch (error) {
    logger.error(
      'desktop',
      `Failed to refresh model list: ${toErrorMessage(error)}`,
    );
  }
}
