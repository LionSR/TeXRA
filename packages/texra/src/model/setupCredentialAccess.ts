import { Settings } from '@texra-ai/harness';
import { Effect } from 'effect';

import { hasUsableApiKey } from '@texra-ai/llm';
import { GlobalStateKey } from '@texra-ai/harness/schemas';
import {
  readModelOptions,
  type ModelOptionStores,
  type PlatformSecrets,
} from '@texra-ai/harness';
import { isModelOptionAvailable } from '@shared/schemas';
import { modelOptionsFrom } from '@texra/model/modelOptions';
import { SETUP_MODEL_BY_PROVIDER } from '@texra/model/setupModelDefaults';
import type { SettingsStores } from '@texra-ai/harness';

/**
 * The setup assistant's launch model: the first provider setup model the
 * picker reports available, preferring one a subscription pays for. A
 * provider's setup model counts only on that provider's own credential, so
 * another provider's model riding OpenRouter never stands in for OpenRouter's
 * own setup model.
 *
 * `includeAccessListFallback` offers OpenRouter's setup model while the
 * OpenRouter switch is off, as a last resort: the extension prompts first and
 * turns the switch on for that launch (`requiresOpenRouter`), while desktop
 * has no prompt to explain the flip and opts out.
 */
export const resolveSetupLaunchModel = Effect.fn('resolveSetupLaunchModel')(
  function* (
    stores: SettingsStores,
    secrets: PlatformSecrets,
    includeAccessListFallback: boolean,
  ) {
    const candidates = Object.entries(SETUP_MODEL_BY_PROVIDER);
    const options = yield* readModelOptions(
      { ...stores, secrets },
      candidates.map(([, model]) => model),
    );
    const byModel = new Map(options.map((option) => [option.model, option]));
    const rows = new Map(
      modelOptionsFrom(options).map((row) => [row.value, row]),
    );
    const runnable = candidates.flatMap(([provider, model]) => {
      const row = rows.get(model);
      return row !== undefined &&
        isModelOptionAvailable(row) &&
        (row.availability === 'openrouter-key') === (provider === 'openRouter')
        ? [{ row, paidByPlan: byModel.get(model)?.usageRoute !== undefined }]
        : [];
    });
    const pick = (runnable.find(({ paidByPlan }) => paidByPlan) ?? runnable[0])
      ?.row;
    if (pick) {
      return {
        model: pick.value,
        requiresOpenRouter: pick.availability === 'openrouter-key',
      };
    }
    if (
      !includeAccessListFallback ||
      (yield* Settings.get<boolean>(stores, GlobalStateKey.USE_OPENROUTER))
    ) {
      return null;
    }
    return (yield* hasUsableApiKey(secrets, 'openRouter'))
      ? { model: SETUP_MODEL_BY_PROVIDER.openRouter, requiresOpenRouter: true }
      : null;
  },
);

/**
 * True when the setup assistant has a model to launch with, the OpenRouter
 * last resort included. A check that cannot be answered fails typed: an
 * unreadable store is not the fact "no credential", and each caller decides
 * what an unknown answer means for its surface.
 */
export const hasUsableSetupCredential = (
  stores: SettingsStores,
  secrets: PlatformSecrets,
) =>
  resolveSetupLaunchModel(stores, secrets, true).pipe(
    Effect.map((resolution) => resolution !== null),
  );

/** The picker's model options as the follow-up controls list them, read live. */
export const loadModelOptions = (stores: ModelOptionStores) =>
  readModelOptions(stores).pipe(Effect.map(modelOptionsFrom));
