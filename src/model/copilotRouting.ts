/**
 * Copilot routing: per-model preference for serving a canonical base model
 * through the editor's GitHub Copilot language-model access instead of a
 * provider key, OpenRouter, or a subscription.
 *
 * The preference is persisted state, while the discovered route lives in
 * `runtimeModelRegistry`. This module combines those facts when explaining
 * why a preferred route is unavailable.
 */

import { platform } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { copilotRouteForModel } from './runtimeModelRegistry';

/** One-launch override for a deliberate direct-key retry. */
export type CopilotRouteOverride = 'direct';

function copilotRouteModels(): readonly string[] {
  return platform().globalState.get<readonly string[]>(
    GlobalStateKey.COPILOT_ROUTE_MODELS,
    [],
  );
}

/**
 * Persisted canonical model ids whose Copilot route the user prefers. Settings
 * needs the raw list so a model the editor no longer discovers still surfaces
 * its undo (#9659).
 */
export function preferredCopilotRouteModels(): readonly string[] {
  return [...copilotRouteModels()];
}

/** Whether the user prefers the Copilot route for this canonical base model. */
export function prefersCopilotRoute(model: string): boolean {
  return copilotRouteModels().includes(model);
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
 * Why a Copilot-preferred model cannot be served through Copilot right now,
 * or undefined when it can. The preference is a hard route choice (#9635):
 * handler routing reports this reason and never falls through to a provider
 * key, OpenRouter, or a subscription the user did not choose for this model.
 */
export function copilotRouteUnavailableReason(
  model: string,
): string | undefined {
  if (!prefersCopilotRoute(model)) return undefined;
  const access = copilotRouteForModel(model)?.access;
  if (access === 'allowed') return undefined;
  switch (access) {
    case 'consent-required':
      return `Copilot access to "${model}" needs your approval in VS Code. Grant it from Settings → Models, or stop using Copilot for this model.`;
    case 'unavailable':
      return `Copilot access to "${model}" is temporarily unavailable in VS Code.`;
    // No discovered route means Copilot cannot serve the model right now.
    case undefined:
      break;
    default:
      access satisfies never;
  }
  return `VS Code does not currently offer "${model}" through Copilot.`;
}
