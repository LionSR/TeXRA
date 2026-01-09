// Local imports - event bus
import { bus } from '@eventBus/ProgressEventBus';

let initialized = false;
let extensionIsDeactivating = false;
let cleanup: (() => void) | undefined;

export function initializeExtensionLifecycle(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  extensionIsDeactivating = false;

  cleanup = bus.on('extensionDeactivating', () => {
    extensionIsDeactivating = true;
  });
}

export function disposeExtensionLifecycle(): void {
  cleanup?.();
  cleanup = undefined;
  initialized = false;
}

export function isExtensionDeactivating(): boolean {
  return extensionIsDeactivating;
}
