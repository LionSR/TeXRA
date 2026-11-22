// Third-party imports
import { Effect } from 'effect';

import { LaunchRefused } from '@texra-ai/worldline';

// Local imports
import type { RunModelCandidate } from '@texra-ai/worldline/host';
import type { SettingsStores } from '@texra-ai/worldline/plugins';
import { isModelOptionAvailable, joinFacts } from '@texra-ai/worldline/schemas';
import { codingPlanForUsageRoute } from '@texra/shared/model/codingPlans';
import type { ModelOptionData } from '@texra/shared/pickerOptions';
import {
  chooseLaunchModel,
  loadModelOptions,
} from '@texra/model/setupCredentialAccess';

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

interface CliRunnableModelOptions {
  readonly stores: SettingsStores;
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
  return modelAvailabilityLabel(model).toLowerCase();
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

export function formatCliModelDetails(model: ModelOptionData): string {
  const lines: string[] = [];
  lines.push(`id: ${model.value}`);
  lines.push(`label: ${model.label}`);
  if (model.provider) lines.push(`provider: ${model.provider}`);
  lines.push(`status: ${cliModelStatus(model)}`);
  lines.push(`availability: ${modelAvailabilityLabel(model)}`);
  // Why it cannot run is the verdict's own sentence; how to add a key
  // from a shell is the terminal's.
  if (model.unavailableReason) lines.push(`reason: ${model.unavailableReason}`);
  if (model.availability === 'missing-key')
    lines.push(`recovery: ${CLI_SETUP_RECOVERY}`);
  if (model.context) lines.push(`context: ${model.context}`);
  if (model.cost) lines.push(`cost: ${model.cost}`);
  if (model.hint) {
    lines.push('');
    lines.push(model.hint);
  }
  return lines.join('\n');
}

/**
 * The row `texra models show` describes: the listed row a CLI spelling names
 * (`grok-4.7`, `Opus 5.5`), else the row of the catalog model it names that
 * the picker does not list.
 */
export const loadCliModelAccessEntry = Effect.fn('loadCliModelAccessEntry')(
  function* (model: string, stores: SettingsStores) {
    const models = yield* loadModelOptions(stores);
    const trimmed = model.trim();
    const listedEntry = findCliModelAccessEntry(models, trimmed);
    if (listedEntry || trimmed.length === 0) return listedEntry;

    const hiddenModelId = resolveKnownCliModelId(trimmed);
    if (hiddenModelId == null) return undefined;
    const [hiddenEntry] = yield* loadModelOptions(stores, [hiddenModelId]);
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

/**
 * The model a CLI run takes, from its candidates: the app decides
 * (`chooseLaunchModel`), and this words a fallback's notice and a refusal.
 * A candidate's CLI spelling resolves to its catalog id first; a message
 * names the model as the person spelled it.
 */
export const selectCliRunnableModel = Effect.fn('selectCliRunnableModel')(
  function* (
    candidates: readonly RunModelCandidate[],
    options: CliRunnableModelOptions,
  ) {
    const spelled = new Map<string, string>();
    const resolved = candidates.flatMap((candidate) => {
      const given = candidate.model?.trim();
      if (!given) return [];
      const model = resolveKnownCliModelId(given) ?? given;
      if (!spelled.has(model)) spelled.set(model, given);
      return [{ ...candidate, model }];
    });
    const { decision, rows, runnable } = yield* chooseLaunchModel(
      options.stores,
      resolved,
    );
    const unavailable = (model: string) =>
      formatUnavailableModelMessage(
        spelled.get(model) ?? model,
        rows.find((row) => row.value === model),
        runnable,
        options,
      );

    if (decision?._tag === 'Chosen') {
      return { model: decision.model } satisfies CliRunnableModelResolution;
    }
    if (decision?._tag === 'Fallback') {
      // The rows know why the model cannot run, which the decision's own
      // notice does not say.
      return {
        model: decision.model,
        notice: `${unavailable(decision.from.model)} Using "${decision.model}" instead.`,
      } satisfies CliRunnableModelResolution;
    }
    const requestedModel = (decision?.model ?? resolved[0]?.model) || '<empty>';
    return yield* new LaunchRefused({ message: unavailable(requestedModel) });
  },
);
