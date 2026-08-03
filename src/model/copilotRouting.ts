/**
 * Copilot routing: per-model preference for serving a canonical base model
 * through the editor's GitHub Copilot language-model access instead of a
 * provider key, OpenRouter, or a subscription.
 *
 * Mirrors the OpenRouter precedent (`openRouterRouting.ts`): the preference
 * is persisted state, the discovered route lives in
 * `runtimeModelRegistry`, and this module owns the single predicate both the
 * availability computation and `ModelFactory` consult, so picker and request
 * construction can never drift on which transport a model uses.
 */

import { platform } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { copilotRouteForModel } from './runtimeModelRegistry';

function copilotRouteModels(): readonly string[] {
  return (
    platform().globalState.get<readonly string[]>(
      GlobalStateKey.COPILOT_ROUTE_MODELS,
      [],
    ) ?? []
  );
}

/**
 * Process-local, launch-scoped routing override (#9635): a direct-key
 * fallback retry must not re-enter Copilot for the same model, but the
 * user's persisted preference must survive a host crash or reload
 * mid-launch — so the override lives in memory only and never writes
 * global state. Mutated exclusively through
 * {@link withCopilotRouteSuppressed}; empty between launches.
 */
const launchSuppressedModels = new Set<string>();

/**
 * Run `launch` with the Copilot route preference for `model` suppressed.
 * The persisted preference is never touched; a crash mid-launch leaves
 * the user's standing choice intact.
 */
export async function withCopilotRouteSuppressed<T>(
  model: string,
  launch: () => Promise<T>,
): Promise<T> {
  launchSuppressedModels.add(model);
  try {
    return await launch();
  } finally {
    launchSuppressedModels.delete(model);
  }
}

/** Whether the user prefers the Copilot route for this canonical base model. */
export function prefersCopilotRoute(model: string): boolean {
  if (launchSuppressedModels.has(model)) return false;
  return copilotRouteModels().includes(model);
}

/**
 * The persisted per-model preferences, unfiltered by launch suppression.
 * Settings UI needs the raw list so a preferred model the editor no longer
 * discovers still surfaces its undo (#9659).
 */
export function preferredCopilotRouteModels(): readonly string[] {
  return copilotRouteModels();
}

/** Persist (or clear) the Copilot route preference for one base model. */
export async function setCopilotRoutePreference(
  model: string,
  preferred: boolean,
): Promise<void> {
  const current = copilotRouteModels();
  const next = preferred
    ? [...new Set([...current, model])]
    : current.filter((entry) => entry !== model);
  await platform().globalState.update(
    GlobalStateKey.COPILOT_ROUTE_MODELS,
    next,
  );
}

/**
 * Whether a request for this model should be served through Copilot. The
 * preference alone is not enough: the editor must currently offer the model
 * with access granted. When the route cannot serve a preferred model, the
 * availability layer reports the route state (consent required / unavailable)
 * instead of silently switching transports.
 */
export function shouldRouteModelThroughCopilot(model: string): boolean {
  return (
    prefersCopilotRoute(model) &&
    copilotRouteForModel(model)?.access === 'allowed'
  );
}

/**
 * Why a Copilot-preferred model cannot be served through Copilot right now,
 * or undefined when it can. The preference is a hard route choice (#9635):
 * handler routing reports this reason and never falls through to a provider
 * key, OpenRouter, or a subscription the user did not choose for this model.
 */
export function copilotRouteUnavailableReason(
  model: string,
): string | undefined {
  if (!prefersCopilotRoute(model)) return undefined;
  if (shouldRouteModelThroughCopilot(model)) return undefined;
  switch (copilotRouteForModel(model)?.access) {
    case 'consent-required':
      return `Copilot access to "${model}" needs your consent in VS Code. Grant it from Settings → Models, or clear the Copilot route preference.`;
    case 'unavailable':
      return `Copilot access to "${model}" is temporarily unavailable in VS Code.`;
    default:
      return `VS Code does not currently offer "${model}" through Copilot.`;
  }
}
