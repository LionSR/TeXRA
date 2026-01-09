// Local imports - event bus
import { bus } from '@eventBus/ProgressEventBus';

let initialized = false;
let extensionIsDeactivating = false;

export function initializeExtensionLifecycle(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  bus.on('extensionDeactivating', () => {
    extensionIsDeactivating = true;
  });
}

export function isExtensionDeactivating(): boolean {
  return extensionIsDeactivating;
}
