/**
 * CLI projection of the enabled-models catalog. The selection itself
 * (`MODEL_SELECTION_KEY.key`) is owned by the harness —
 * `getEnabledModels` reads it, `setModelEnabled` writes it and enforces the
 * "at least one enabled" and "never enable a retired model" invariants for
 * every host, and `enableableModels` is the catalog every host lists. This
 * module only resolves CLI argument spellings and shapes the rows
 * `texra models enabled` and the `/models` form print.
 *
 * The global state store arrives from the caller (the CLI composition root's
 * own `CliPlatformServices`, or the `AppState` service), so the read and the
 * write that follows it hit the same store.
 */
import { Effect } from 'effect';

import { modelRefOf, resolveModelSource } from '@texra-ai/llm';
import {
  enableableModels,
  getEnabledModels,
  setModelEnabled,
} from '@texra-ai/worldline/host';
import type {
  SettingsStores,
  StateReadFailed,
  StateWriteFailed,
} from '@texra-ai/worldline/plugins';
import { getModelLabel } from '@texra-ai/worldline/schemas';

import { resolveKnownCliModelId } from '../platform/cliConfig';
import { type CliUsageError, failUsage } from '../platform/cliContext';

export interface CliEnabledModelRow {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly enabled: boolean;
  readonly deprecated: boolean;
}

/**
 * The catalog for enable/disable UIs: every model a person can switch on,
 * under the provider the Models tab groups it by, marked with whether it is
 * currently enabled.
 */
export const listCliEnabledModelCatalog = Effect.fn(
  'listCliEnabledModelCatalog',
)(function* (stores: Pick<SettingsStores, 'config' | 'globalState'>) {
  const enabled = new Set(yield* getEnabledModels(stores));
  return enableableModels()
    .map((config) => ({
      id: config.ref,
      label: getModelLabel(config.ref),
      provider: resolveModelSource(config),
      enabled: enabled.has(config.ref),
      deprecated: config.deprecated ?? false,
    }))
    .toSorted((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
});

/**
 * Enable or disable one model from a CLI argument, resolving common spellings
 * (`grok-4.7` → `xai/grok-4.7`) before handing the id to the shared writer.
 *
 * One program: the caller runs it on the process runtime, so this refusal and
 * the writer's own invariant refusals land in the same channel — an unknown
 * id as a `CliUsageError`, the writer's as its own typed refusals — and
 * both stay inside the program rather than at the call site.
 */
export function setCliModelEnabled(
  stores: Pick<SettingsStores, 'config' | 'globalState'>,
  modelInput: string,
  enabled: boolean,
): Effect.Effect<
  {
    readonly model: string;
    readonly enabled: boolean;
    readonly list: readonly string[];
  },
  CliUsageError | StateWriteFailed | StateReadFailed
> {
  return Effect.gen(function* () {
    // Enablement belongs to the model, not to an effort or mode suffix.
    const resolved = resolveKnownCliModelId(modelInput);
    const model = resolved && (modelRefOf(resolved) ?? resolved);
    if (!model)
      return yield* failUsage(
        `Unknown model "${modelInput}". Use an id from \`texra models list --all\`.`,
      );
    const list = yield* setModelEnabled({ model, enabled, stores });
    return { model, enabled: list.includes(model), list };
  });
}
