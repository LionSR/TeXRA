import { StateReadFailed, readModelOptions } from '@texra-ai/harness/host';
import { Effect } from 'effect';

import { isModelOptionAvailable } from '@texra-ai/harness/schemas';
import { modelOptionsFrom } from '@texra/model/modelOptions';
import { SETUP_MODEL_BY_PROVIDER } from '@texra/model/setupModelDefaults';
import type { SettingsStores } from '@texra-ai/harness/host';

/**
 * The setup assistant's launch model: the first provider setup model the
 * picker reports available, preferring one a subscription pays for.
 */
export const resolveSetupLaunchModel = Effect.fn('resolveSetupLaunchModel')(
  function* (stores: SettingsStores) {
    const models = Object.values(SETUP_MODEL_BY_PROVIDER);
    const options = yield* readModelOptions(stores, models);
    const byModel = new Map(options.map((option) => [option.model, option]));
    const rows = new Map(
      modelOptionsFrom(options).map((row) => [row.value, row]),
    );
    const runnable = models.flatMap((model) => {
      const row = rows.get(model);
      return row !== undefined && isModelOptionAvailable(row)
        ? [{ row, paidByPlan: byModel.get(model)?.usageRoute !== undefined }]
        : [];
    });
    const pick = (runnable.find(({ paidByPlan }) => paidByPlan) ?? runnable[0])
      ?.row;
    if (pick) return pick.value;
    // A key that could not be read is neither a credential nor its absence:
    // with nothing runnable, the answer is unknown, not "none".
    const unreadable = Object.entries(SETUP_MODEL_BY_PROVIDER).find(
      ([, model]) => rows.get(model)?.availability === 'key-unreadable',
    );
    if (unreadable !== undefined) {
      return yield* new StateReadFailed({
        key: unreadable[0],
        message: `Could not read the ${unreadable[0]} key, so whether setup has a model is unknown.`,
        cause: undefined,
      });
    }
    return null;
  },
);

/**
 * True when the setup launch has a model to launch with. A check that cannot
 * be answered fails typed: an unreadable store is not the fact "no
 * credential", and each caller decides what an unknown answer means for its
 * surface.
 */
export const hasUsableSetupCredential = (stores: SettingsStores) =>
  resolveSetupLaunchModel(stores).pipe(Effect.map((model) => model !== null));

/** The picker's model options as the follow-up controls list them, read live. */
export const loadModelOptions = (stores: SettingsStores) =>
  readModelOptions(stores).pipe(Effect.map(modelOptionsFrom));
