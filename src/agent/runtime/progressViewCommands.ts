export interface RuntimeProgressViewVisibilityProvider {
  isViewVisible(): boolean;
}

export interface RuntimeProgressViewVisibilityRegistration {
  dispose(): void;
}

const visibilityProviders = new Set<RuntimeProgressViewVisibilityProvider>();

/**
 * Register the host-owned progress-view visibility provider.
 *
 * Hosts own the actual UI surface; runtime code only asks whether the progress
 * view is already visible before emitting a fallback open/notification request.
 * Multiple hosts may coexist in one process, so visibility is true when any
 * live provider reports a visible progress surface.
 */
export function registerRuntimeProgressViewVisibilityProvider(
  provider: RuntimeProgressViewVisibilityProvider,
): RuntimeProgressViewVisibilityRegistration {
  visibilityProviders.add(provider);
  return {
    dispose: () => {
      visibilityProviders.delete(provider);
    },
  };
}

/** Return whether the registered host progress view is currently visible. */
export function isRuntimeProgressViewVisible(): boolean {
  for (const provider of visibilityProviders) {
    if (provider.isViewVisible()) {
      return true;
    }
  }
  return false;
}
