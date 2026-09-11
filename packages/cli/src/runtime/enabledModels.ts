/**
 * CLI projection of the enabled-models catalog. The selection itself
 * (`GlobalStateKey.MODEL_SELECTION`) is owned by `@model/computeModelOptions` —
 * `getEnabledModels` reads it, `setModelEnabled` writes it and enforces the
 * "at least one enabled" and "never enable a retired model" invariants for
 * every host. This module only resolves CLI argument spellings and shapes the
 * rows `texra models enabled` and the `/models` form print.
 *
 * The global state store arrives from the caller (the CLI composition root's
 * own `CliPlatformServices`, or the `AppState` service), so the read and the
 * write that follows it hit the same store.
 */
import { getEnabledModels, setModelEnabled } from '@model/computeModelOptions';
import { isDeprecatedModel, isRetiredModel } from '@model/modelOptionsBasic';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import type { StateStore } from '@platform/interfaces';
import { getModelLabel } from '@shared/model/modelLabel';

import { knownCliModelIds, resolveKnownCliModelId } from './cliConfig';

export interface CliEnabledModelRow {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly enabled: boolean;
  readonly deprecated: boolean;
}

/**
 * Full catalog for enable/disable UIs: every non-retired CLI-supported model,
 * marked with whether it is currently enabled.
 */
export function listCliEnabledModelCatalog(
  state: StateStore,
): readonly CliEnabledModelRow[] {
  const enabled = new Set(getEnabledModels(state));
  return knownCliModelIds()
    .filter((id) => !isRetiredModel(id))
    .map((id) => {
      const config = getRuntimeModelConfig(id);
      return {
        id,
        label: getModelLabel(id),
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
  state: StateStore,
  modelInput: string,
  enabled: boolean,
): Promise<{
  readonly model: string;
  readonly enabled: boolean;
  readonly list: readonly string[];
}> {
  const model = resolveKnownCliModelId(modelInput);
  if (!model) {
    throw new Error(
      `Unknown model "${modelInput}". Use an id from \`texra models list --all\`.`,
    );
  }

  const list = await setModelEnabled({ model, enabled, state });
  return { model, enabled: list.includes(model), list };
}
