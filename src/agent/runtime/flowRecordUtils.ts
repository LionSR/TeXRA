// Local imports - agent runtime
import { isExtensionDeactivating } from '@agent/runtime/extensionLifecycle';

// Local imports - logger
import { END_GROUP_STATUS, type EndGroupStatus } from '@logger/messageTypes';

export function shouldPreserveFlowRecord(
  status: EndGroupStatus,
  userCancelledRetry: boolean,
): boolean {
  if (isExtensionDeactivating()) {
    return true;
  }

  if (status !== END_GROUP_STATUS.STOPPED) {
    return true;
  }

  if (userCancelledRetry) {
    return true;
  }

  return false;
}
