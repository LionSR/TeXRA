// Local imports - agent runtime
import { isExtensionDeactivating } from '@agent/runtime/extensionLifecycle';

// Local imports - logger
import { END_GROUP_STATUS, type EndGroupStatus } from '@logger/messageTypes';

export function shouldPreserveFlowRecord(
  status: EndGroupStatus,
  userCancelledRetry: boolean,
): boolean {
  return (
    isExtensionDeactivating() ||
    status !== END_GROUP_STATUS.STOPPED ||
    userCancelledRetry
  );
}
