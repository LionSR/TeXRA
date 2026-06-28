export interface RuntimeProgressViewVisibilityProvider {
  isViewVisible(): boolean;
}

export interface RuntimeProgressViewVisibilityRegistration {
  dispose(): void;
}

let visibilityProvider: RuntimeProgressViewVisibilityProvider | null = null;

/**
 * Register the host-owned progress-view visibility provider.
 *
 * Hosts own the actual UI surface; runtime code only asks whether the progress
 * view is already visible before emitting a fallback open/notification request.
 */
export function registerRuntimeProgressViewVisibilityProvider(
  provider: RuntimeProgressViewVisibilityProvider,
): RuntimeProgressViewVisibilityRegistration {
  visibilityProvider = provider;
  return {
    dispose: () => {
      if (visibilityProvider === provider) {
        visibilityProvider = null;
      }
    },
  };
}

/** Return whether the registered host progress view is currently visible. */
export function isRuntimeProgressViewVisible(): boolean {
  return visibilityProvider?.isViewVisible() ?? false;
}
