import {
  readModelOptions,
  type RunModelCandidate,
} from '@texra-ai/worldline/host';
import { Array as Arr, Effect, Result } from 'effect';

import { modelConfig } from '@texra-ai/llm';
import { isModelOptionAvailable } from '@texra-ai/worldline/schemas';
import { decideLaunchModel, modelOptionsFrom } from '@texra/model/modelOptions';
import type { ModelOptionData } from '@texra/shared/pickerOptions';
import { SETUP_MODEL_BY_PROVIDER } from '@texra/model/setupModelDefaults';
import {
  type SettingsStores,
  StateReadFailed,
} from '@texra-ai/worldline/plugins';

/**
 * The setup assistant's launch model: the first provider setup model the
 * picker reports available, preferring one a subscription pays for.
 */
export const resolveSetupLaunchModel = Effect.fn('resolveSetupLaunchModel')(
  function* (stores: SettingsStores) {
    const models = Object.values(SETUP_MODEL_BY_PROVIDER);
    const options = yield* readModelOptions(stores, models);
    const byModel = new Map(options.map((option) => [option.model, option]));
    const isRunnable = (model: string): boolean => {
      const option = byModel.get(model);
      return option !== undefined && isModelOptionAvailable(option);
    };
    const pick =
      models.find(
        (model) =>
          byModel.get(model)?.usageRoute !== undefined && isRunnable(model),
      ) ?? models.find(isRunnable);
    if (pick !== undefined) return pick;
    // A key that could not be read is neither a credential nor its absence:
    // with nothing runnable, the answer is unknown, not "none".
    const unreadable = Object.entries(SETUP_MODEL_BY_PROVIDER).find(
      ([, model]) => byModel.get(model)?.availability === 'key-unreadable',
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

/**
 * The picker's rows, read live: every visible model's (the harness's default
 * list), or those of `models`, one each, in order. Each row carries its
 * availability verdict, which every host words itself.
 */
export const loadModelOptions = (
  stores: SettingsStores,
  models?: readonly string[],
) => readModelOptions(stores, models).pipe(Effect.map(modelOptionsFrom));

/**
 * The model a launch takes from its candidates, over what this user can run
 * now: the picker's rows, plus a row for each candidate the catalog
 * describes but the picker does not list, since a model need not be enabled
 * to run. Each such row is read on its own, and a read that fails fails the
 * choice only when the decision lands on that candidate, so a sibling's
 * failure never refuses a launch that does not need it.
 */
export const chooseLaunchModel = Effect.fn('chooseLaunchModel')(function* (
  stores: SettingsStores,
  candidates: readonly RunModelCandidate[],
) {
  const listed = yield* loadModelOptions(stores);
  const unlisted = [
    ...new Set(
      candidates.flatMap(({ model }) => {
        const id = model?.trim();
        return id &&
          modelConfig(id) !== undefined &&
          !listed.some((row) => row.value === id)
          ? [id]
          : [];
      }),
    ),
  ];
  const reads = yield* Effect.forEach(
    unlisted,
    (id) =>
      loadModelOptions(stores, [id]).pipe(
        Effect.match({
          onSuccess: Result.succeed,
          onFailure: (failure) => Result.fail([id, failure] as const),
        }),
      ),
    { concurrency: 'unbounded' },
  );
  const [readable, failures] = Arr.separate(reads);
  const rows: ModelOptionData[] = [...listed, ...readable.flat()];
  const failed = new Map(failures);
  const choice = decideLaunchModel(rows, candidates);
  const { decision } = choice;
  // The candidate the decision could not run: why is in its row, so a row
  // that could not be read is the failure itself.
  const refused =
    decision?._tag === 'Fallback' ? decision.from.model : decision?.model;
  const failure = refused === undefined ? undefined : failed.get(refused);
  if (failure !== undefined) return yield* failure;
  return { ...choice, rows };
});
