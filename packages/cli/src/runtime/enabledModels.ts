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
import { Effect } from 'effect';

import { getEnabledModels, setModelEnabled } from '@model/computeModelOptions';
import { isDeprecatedModel, isRetiredModel } from '@model/modelOptionsBasic';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import type { StateStore } from '@platform/interfaces';
import { StateWriteFailed } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
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
 *
 * One program: the caller runs it on the process runtime, so this refusal and
 * the writer's own invariant refusals land in the same channel — the
 * unknown-id case as a `StateWriteFailed`, the writer's as its own typed
 * refusals — and `Effect.suspend` keeps both inside the program rather than
 * at the call site.
 */
export function setCliModelEnabled(
  state: StateStore,
  modelInput: string,
  enabled: boolean,
): Effect.Effect<
  {
    readonly model: string;
    readonly enabled: boolean;
    readonly list: readonly string[];
  },
  StateWriteFailed
> {
  return Effect.suspend(() => {
    const model = resolveKnownCliModelId(modelInput);
    if (!model) {
      // A refusal in the channel this signature declares, not a defect: the
      // caller shows it to the user, and a defect would reach that caller as a
      // FiberFailure with the message buried in the pretty-printed cause.
      const message = `Unknown model "${modelInput}". Use an id from \`texra models list --all\`.`;
      return Effect.fail(
        new StateWriteFailed({
          key: GlobalStateKey.MODEL_SELECTION,
          message,
          cause: new Error(message),
        }),
      );
    }

    return setModelEnabled({ model, enabled, state }).pipe(
      Effect.map((list) => ({ model, enabled: list.includes(model), list })),
    );
  });
}
