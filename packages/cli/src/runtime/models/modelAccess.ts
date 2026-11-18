// Third-party imports
import { Effect, Result, absurd } from 'effect';

import { LaunchRefused } from '@texra-ai/harness';

// Local imports
import { decideRunModel, type RunModelCandidate } from '@texra-ai/harness/host';
import type { SettingsStores } from '@texra-ai/harness/plugins';
import { isModelOptionAvailable, joinFacts } from '@texra-ai/harness/schemas';
import { codingPlanForUsageRoute } from '@texra/shared/model/codingPlans';
import type { ModelOptionData } from '@texra/shared/pickerOptions';
import { loadModelOptions } from '@texra/model/setupCredentialAccess';

// Local file imports
import { modelAvailabilityLabel } from '@ui/copy/modelAccess';
import { resolveKnownCliModelId } from '../platform/cliConfig';

export interface CliModelPickerItem {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
}

/**
 * The shape both success returns below satisfy. Not exported: the resolution
 * reaches callers as the success channel of `selectCliRunnableModel`'s
 * Effect, so there is no second name for it to travel under.
 */
interface CliRunnableModelResolution {
  readonly model: string;
  readonly notice?: string;
}

interface CliModelAccessEntryOptions {
  readonly stores: SettingsStores;
  /** Optional preloaded list, used by commands that already fetched access. */
  readonly accessList?: readonly ModelOptionData[];
}

interface CliRunnableModelOptions extends Pick<
  CliModelAccessEntryOptions,
  'stores' | 'accessList'
> {
  /** What to do when no model can run, as one sentence; the shell's
   *  `texra setup` unless the surface has its own way to add a key. */
  readonly recovery?: string;
}

export interface CliModelListOptions {
  readonly includeUnavailable?: boolean;
}

const NO_RUNNABLE_MODEL_ACCESS_COPY = 'No models are available';

/** Points shell users at the guided setup picker rather than leaving them
 *  to figure out key storage on their own. */
export const CLI_SETUP_RECOVERY = 'Add a provider API key with `texra setup`.';

export function formatCliNoRunnableModelsMessage(
  recovery: string = CLI_SETUP_RECOVERY,
): string {
  return `${NO_RUNNABLE_MODEL_ACCESS_COPY}. ${recovery}`;
}

/** A row's availability as the terminal's sentence-case rows read it: the
 *  kind's label, lower-cased. */
export function cliModelStatus(model: ModelOptionData): string {
  return model.availability === undefined
    ? 'available'
    : modelAvailabilityLabel({
        availability: model.availability,
        usageRoute: model.usageRoute,
      }).toLowerCase();
}

/**
 * The picker row's access, naming the coding plan when one pays for the next
 * request (the option's `usageRoute`, decided by the picker).
 */
function formatModelStatusForCli(model: ModelOptionData): string {
  const plan = codingPlanForUsageRoute(model.usageRoute);
  return `api: ${plan?.displayName ?? cliModelStatus(model)}`;
}

// Reason a given model id cannot be switched to right now, or undefined if it can.
export type GetModelSwitchDisabledReason = (
  model: string,
) => Effect.Effect<string | undefined, Error>;

export function modelSelectItemsForCli(
  models: readonly ModelOptionData[],
  getModelSwitchDisabledReason?: GetModelSwitchDisabledReason,
) {
  return Effect.forEach(
    models.filter(isModelOptionAvailable),
    Effect.fnUntraced(function* (model) {
      const disabledReason = getModelSwitchDisabledReason
        ? yield* getModelSwitchDisabledReason(model.value)
        : undefined;
      const access = formatModelStatusForCli(model);
      const status = joinFacts([
        access,
        model.reasoning && `reasoning setting: ${model.reasoning}`,
      ]);
      return {
        value: model.value,
        label: model.label || model.value,
        description: disabledReason ? `${disabledReason}; ${status}` : status,
        disabled: disabledReason != null,
      } satisfies CliModelPickerItem;
    }),
  );
}

function findCliModelAccessEntry(
  models: readonly ModelOptionData[],
  model: string,
): ModelOptionData | undefined {
  const exact = models.find((entry) => entry.value === model);
  if (exact) return exact;

  const lower = model.toLowerCase();
  const lowerMatch = models.find(
    (entry) => entry.value.toLowerCase() === lower,
  );
  if (lowerMatch) return lowerMatch;

  const canonical = resolveKnownCliModelId(model);
  if (!canonical) return undefined;
  return models.find((entry) => entry.value === canonical);
}

/**
 * Output projection for JSON/NDJSON: the model id is addressable under the
 * same key (`.id`) as every other CLI resource (`agents`, `history`).
 *
 * The record is the whole of `ModelOptionData`, so it follows that schema: at
 * 1.0 the fanned-out `availabilityLabel`, `requiresKey` and `disabled` keys are
 * gone and `availability` (the machine-readable kind) is what a consumer reads;
 * the human label for a kind is `modelAvailabilityLabel`.
 */
export function cliModelRecord(
  model: ModelOptionData,
): { id: string } & Omit<ModelOptionData, 'value'> {
  const { value, ...rest } = model;
  return { id: value, ...rest };
}

export function listableModelAccessEntries(
  models: readonly ModelOptionData[],
  options: CliModelListOptions = {},
): readonly ModelOptionData[] {
  if (options.includeUnavailable === true) return models;
  return models.filter(isModelOptionAvailable);
}

export function formatNoListableModelsMessage(
  options: CliModelListOptions = {},
): string {
  return [
    'No models are currently available.',
    ...(options.includeUnavailable === true
      ? []
      : [
          'Run `texra models list --all` to see unavailable models and access status.',
        ]),
    CLI_SETUP_RECOVERY,
  ].join('\n');
}

function formatCliModelRecovery(model: ModelOptionData): string | undefined {
  if (isModelOptionAvailable(model)) return undefined;

  const availability = model.availability;

  switch (availability) {
    case 'missing-key':
      return CLI_SETUP_RECOVERY;
    case 'key-unreadable':
      return 'The API key could not be read from secret storage: check that the store is unlocked and readable, then retry.';
    case 'provider-key':
      return undefined;
    case 'retired':
      return 'Choose an active model.';
    case 'unserved':
      return 'Only OpenRouter or GitHub Copilot serves this model, which TeXRA no longer supports: choose another model.';
    case 'subscription-access':
    case undefined:
      return undefined;
    case 'unknown-model':
      return 'Choose a model that is available in the current registry.';
    default:
      return absurd(availability);
  }
}

export function formatCliModelDetails(model: ModelOptionData): string {
  const lines: string[] = [];
  lines.push(`id: ${model.value}`);
  lines.push(`label: ${model.label}`);
  if (model.provider) lines.push(`provider: ${model.provider}`);
  lines.push(`status: ${cliModelStatus(model)}`);
  if (model.availability)
    lines.push(
      `availability: ${modelAvailabilityLabel({
        availability: model.availability,
        usageRoute: model.usageRoute,
      })}`,
    );
  const recovery = formatCliModelRecovery(model);
  if (recovery) lines.push(`recovery: ${recovery}`);
  if (model.context) lines.push(`context: ${model.context}`);
  if (model.cost) lines.push(`cost: ${model.cost}`);
  if (model.hint) {
    lines.push('');
    lines.push(model.hint);
  }
  return lines.join('\n');
}

/** The caller's preloaded list, or one computed now. */
const loadCliModelAccessList = Effect.fn('loadCliModelAccessList')(function* (
  options: CliModelAccessEntryOptions,
) {
  const models: readonly ModelOptionData[] =
    options.accessList ?? (yield* loadModelOptions(options.stores));
  return models;
});

export const loadCliModelAccessEntry = Effect.fn('loadCliModelAccessEntry')(
  function* (model: string, options: CliModelAccessEntryOptions) {
    const models = yield* loadCliModelAccessList(options);
    const trimmed = model.trim();
    const listedEntry = findCliModelAccessEntry(models, trimmed);
    if (listedEntry || trimmed.length === 0) return listedEntry;

    const hiddenModelId = resolveKnownCliModelId(trimmed);
    if (hiddenModelId == null) return undefined;

    const [hiddenEntry] = yield* loadModelOptions(options.stores, [
      hiddenModelId,
    ]);
    if (!hiddenEntry) {
      return yield* new LaunchRefused({
        message: `Model "${hiddenModelId}" is configured but has no option data.`,
      });
    }

    return hiddenEntry;
  },
);

type CliAvailableModelsMessageOptions = Pick<
  CliRunnableModelOptions,
  'recovery'
>;

function formatAvailableModels(
  ids: readonly string[],
  options: CliAvailableModelsMessageOptions,
): string {
  if (ids.length > 0) return `Available models: ${ids.join(', ')}.`;
  return `No models are currently available. ${options.recovery ?? CLI_SETUP_RECOVERY}`;
}

function formatUnavailableModelMessage(
  model: string,
  entry: ModelOptionData | undefined,
  availableIds: readonly string[],
  options: CliAvailableModelsMessageOptions,
): string {
  const status = entry ? ` (${cliModelStatus(entry)})` : '';
  return `Model "${model}" is not available${status}. ${formatAvailableModels(availableIds, options)}`;
}

type NormalizedCliModelCandidate = RunModelCandidate & {
  readonly model: string;
};

/**
 * The model a CLI run takes, from its candidates: `decideRunModel` picks by
 * precedence and falls back as each candidate's reason says.
 */
export const selectCliRunnableModel = Effect.fn('selectCliRunnableModel')(
  function* (
    candidates: readonly RunModelCandidate[],
    options: CliRunnableModelOptions,
  ) {
    const models = yield* loadCliModelAccessList(options);
    const requestedCandidates: NormalizedCliModelCandidate[] =
      candidates.flatMap((candidate) => {
        const model = candidate.model?.trim();
        return model ? [{ ...candidate, model }] : [];
      });
    const requestedModels = [
      ...new Set(requestedCandidates.map((candidate) => candidate.model)),
    ];
    // Every requested id gets its own hidden-entry lookup, and a failed one
    // is carried as a value so a sibling's success still counts: only the id
    // the decision actually lands on re-raises its failure below.
    const hiddenEntries = yield* Effect.forEach(
      requestedModels,
      (model) =>
        Effect.result(
          loadCliModelAccessEntry(model, {
            stores: options.stores,
            accessList: models,
          }),
        ),
      { concurrency: 'unbounded' },
    );
    const entryErrorByModel = new Map(
      hiddenEntries.flatMap((result, index) => {
        const model = requestedModels[index];
        return model && Result.isFailure(result)
          ? ([[model, result.failure]] as const)
          : [];
      }),
    );
    let modelsWithHiddenEntry = models;
    for (const result of hiddenEntries) {
      if (Result.isFailure(result)) continue;
      const entry = result.success;
      if (
        entry &&
        !findCliModelAccessEntry(modelsWithHiddenEntry, entry.value)
      ) {
        modelsWithHiddenEntry = [...modelsWithHiddenEntry, entry];
      }
    }
    const runnableEntries = modelsWithHiddenEntry.filter(
      isModelOptionAvailable,
    );
    const availableIds = runnableEntries.map((entry) => entry.value);
    const decision = decideRunModel(
      [
        ...requestedCandidates,
        { model: availableIds[0], reason: 'access-list-default' },
      ],
      (candidate) =>
        findCliModelAccessEntry(runnableEntries, candidate) != null,
    );

    if (decision && decision._tag !== 'Unavailable') {
      const selectedModel =
        findCliModelAccessEntry(runnableEntries, decision.model)?.value ??
        decision.model;
      if (decision._tag === 'Chosen') {
        return { model: selectedModel } satisfies CliRunnableModelResolution;
      }

      const fallbackLoadError = entryErrorByModel.get(decision.from.model);
      if (fallbackLoadError) return yield* fallbackLoadError;

      // The access list knows why the model cannot run, which the decision's
      // own notice does not say.
      const unavailableMessage = formatUnavailableModelMessage(
        decision.from.model,
        findCliModelAccessEntry(modelsWithHiddenEntry, decision.from.model),
        availableIds,
        options,
      );
      return {
        model: selectedModel,
        notice: `${unavailableMessage} Using "${selectedModel}" instead.`,
      } satisfies CliRunnableModelResolution;
    }

    const selectedLoadError = decision
      ? entryErrorByModel.get(decision.model)
      : undefined;
    if (selectedLoadError) return yield* selectedLoadError;

    const requestedModel =
      (decision?.model ?? requestedCandidates[0]?.model) || '<empty>';
    const unavailableMessage = formatUnavailableModelMessage(
      requestedModel,
      findCliModelAccessEntry(modelsWithHiddenEntry, requestedModel),
      availableIds,
      options,
    );
    return yield* new LaunchRefused({ message: unavailableMessage });
  },
);
