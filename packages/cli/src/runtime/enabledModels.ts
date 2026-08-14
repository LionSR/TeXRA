/**
 * CLI access to the enabled-models catalog (`GlobalStateKey.ENABLED_MODELS`).
 *
 * Session pickers (`/model`, lead model) only offer enabled + runnable models.
 * VS Code Settings → Models already toggles this list; these helpers give the
 * CLI and TUI the same surface so users are not stuck with defaults alone.
 */
import { MODEL_CONFIGS } from 'llm-zoo';

import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { resolveEffectiveHelperModel } from '@model/helperModelSelection';
import {
  DEFAULT_MODELS,
  isDeprecatedModel,
  isRetiredModel,
} from '@model/modelOptionsBasic';
import { platform } from '@platform/platform';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';

import {
  isCliSupportedModelId,
  knownCliModelIds,
  resolveKnownCliModelId,
} from './cliConfig';

export interface CliEnabledModelRow {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly enabled: boolean;
  readonly deprecated: boolean;
}

function readStoredEnabledModels(): readonly string[] | undefined {
  return platform().globalState.get<readonly string[]>(
    GlobalStateKey.ENABLED_MODELS,
  );
}

/** Models currently shown in pickers (never empty — falls back to defaults). */
export function getCliEnabledModels(): readonly string[] {
  const enabled = readStoredEnabledModels();
  return enabled && enabled.length > 0 ? enabled : DEFAULT_MODELS;
}

function modelLabel(id: string): string {
  const config = MODEL_CONFIGS[id];
  return config?.label ?? config?.fullName ?? id;
}

/**
 * Full catalog for enable/disable UIs: every non-retired CLI-supported model,
 * marked with whether it is currently enabled.
 */
export function listCliEnabledModelCatalog(): readonly CliEnabledModelRow[] {
  const enabled = new Set(getCliEnabledModels());
  return knownCliModelIds()
    .filter((id) => !isRetiredModel(id))
    .map((id) => {
      const config = MODEL_CONFIGS[id];
      return {
        id,
        label: modelLabel(id),
        provider: config?.provider ?? 'unknown',
        enabled: enabled.has(id),
        deprecated: isDeprecatedModel(id),
      };
    })
    .toSorted((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
}

async function persistEnabledModels(models: readonly string[]): Promise<void> {
  await platform().globalState.update(GlobalStateKey.ENABLED_MODELS, [
    ...models,
  ]);
  invalidateModelOptionsCache();
}

/**
 * Enable or disable one model in the shared catalog. Resolves common aliases
 * (`grok-4.5` → `grok45`). Keeps at least one model enabled.
 */
export async function setCliModelEnabled(
  modelInput: string,
  enabled: boolean,
): Promise<{
  readonly model: string;
  readonly enabled: boolean;
  readonly list: readonly string[];
}> {
  const model = resolveKnownCliModelId(modelInput);
  if (!model || !isCliSupportedModelId(model)) {
    throw new Error(
      `Unknown model "${modelInput}". Use an id from \`texra models list --all\`.`,
    );
  }
  if (isRetiredModel(model)) {
    throw new Error(`Model "${model}" is retired and cannot be enabled.`);
  }

  const current = [...getCliEnabledModels()];
  let next: string[];
  if (enabled) {
    next = current.includes(model) ? current : [...current, model];
  } else {
    next = current.filter((id) => id !== model);
    if (next.length === 0) {
      throw new Error(
        'At least one model must stay enabled. Enable another model before disabling this one.',
      );
    }
  }

  await persistEnabledModels(next);

  // If the helper model was just removed, pin the built-in default (matches
  // Settings → Models behavior). Do not fall back to the first remaining
  // picker model — that is a premium default, not the cheap auxiliary.
  const helper = platform().globalState.get<string>(
    GlobalStateKey.HELPER_MODEL,
  );
  if (!enabled && resolveEffectiveHelperModel(helper, current) === model) {
    await platform().globalState.update(
      GlobalStateKey.HELPER_MODEL,
      DEFAULT_HELPER_MODEL,
    );
  }

  return { model, enabled: next.includes(model), list: next };
}
