/**
 * CLI projection of the enabled-models catalog. The list itself
 * (`GlobalStateKey.ENABLED_MODELS`) is owned by `@model/computeModelOptions` —
 * `getEnabledModels` reads it, `setModelEnabled` writes it and enforces the
 * "at least one enabled" and "never enable a retired model" invariants for
 * every host. This module only resolves CLI argument spellings and shapes the
 * rows `texra models enabled` and the `/models` form print.
 */
import { MODEL_CONFIGS } from 'llm-zoo';

import { getEnabledModels, setModelEnabled } from '@model/computeModelOptions';
import { isDeprecatedModel, isRetiredModel } from '@model/modelOptionsBasic';

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

function modelLabel(id: string): string {
  const config = MODEL_CONFIGS[id];
  return config?.label ?? config?.fullName ?? id;
}

/**
 * Full catalog for enable/disable UIs: every non-retired CLI-supported model,
 * marked with whether it is currently enabled.
 */
export function listCliEnabledModelCatalog(): readonly CliEnabledModelRow[] {
  const enabled = new Set(getEnabledModels());
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

/**
 * Enable or disable one model from a CLI argument, resolving common spellings
 * (`grok-4.5` → `grok45`) before handing the id to the shared writer.
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

  const list = await setModelEnabled({ model, enabled });
  return { model, enabled: list.includes(model), list };
}
