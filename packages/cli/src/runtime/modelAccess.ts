// Third-party imports
import { Effect, Result, absurd } from 'effect';

// Local imports
import { decideRunModel, readModelOptions, type ModelOption, type ModelOptionStores, type ProcessRuntime, type RunModelCandidate, type RunModelDecisionReason, type RunModelFallbackMode } from '@texra-ai/harness/host';
import {
  type ModelOptionData,
  type UsageRoute,
  isModelOptionAvailable,
  MODEL_AVAILABILITY_STATUS,
} from '@texra-ai/harness/schemas';
import { modelOptionsFrom } from '@texra/model/modelOptions';

// Local file imports
import { resolveKnownCliModelId } from './cliConfig';
import { formatCliModelAccessRoute } from './modelAccessRoute';

export interface CliModelAccess {
  readonly model: ModelOptionData;
  /** Runnable with the currently configured credentials. */
  readonly available: boolean;
  readonly status: string;
  /** The subscription the picker decided pays for the next request. */
  readonly usageRoute?: UsageRoute;
}

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

const CLI_MODEL_FALLBACK_MODE_BY_REASON = {
  'explicit-override': 'reject',
  environment: 'reject',
  'agent-config': 'notice',
  'command-config': 'notice',
  'workspace-config': 'notice',
  'user-config': 'notice',
  history: 'notice',
  'parent-run': 'notice',
  credential: 'reject',
  'builtin-default': 'silent',
  'access-list-default': 'silent',
} satisfies Record<RunModelDecisionReason, RunModelFallbackMode>;

/** Stores and runtime held by command actions and form loaders. */
export type CliModelStores = ModelOptionStores & {
  readonly runtime: ProcessRuntime;
};

interface CliModelAccessListOptions {
  readonly stores: CliModelStores;
  readonly models?: readonly string[];
}

/**
 * Deliberately does NOT extend {@link CliModelAccessListOptions}:
 * `loadCliModelAccessList` calls `getCliModelAccessList()` with the stores and
 * nothing else, so a `models` filter passed here would be silently dropped.
 * Keeping the field off the type makes that unrepresentable rather than
 * ignored.
 */
interface CliModelAccessEntryOptions {
  readonly stores: CliModelStores;
  /** Optional preloaded list, used by commands that already fetched access. */
  readonly accessList?: readonly CliModelAccess[];
}

interface CliRunnableModelOptions extends Pick<
  CliModelAccessEntryOptions,
  'stores' | 'accessList'
> {
  readonly noAvailableModelsMessage?: string;
}

export interface CliModelListOptions {
  readonly includeUnavailable?: boolean;
}

export interface CliNoAvailableModelsRecoveryOptions {
  readonly configureKeyAction?: string;
}

const NO_RUNNABLE_MODEL_ACCESS_COPY = 'No models are available';

// Point shell users at the guided setup picker rather than leaving them to
// figure out key storage on their own; TUI contexts override this with
// slash-command phrasing.
const DEFAULT_CONFIGURE_KEY_ACTION =
  'add a provider API key with `texra setup`';

function startSentence(text: string): string {
  if (text.length === 0) return text;
  return `${text.at(0)!.toUpperCase()}${text.slice(1)}`;
}

function runnableCliModelAccessEntries(
  models: readonly CliModelAccess[],
): CliModelAccess[] {
  return models.filter((entry) => entry.available);
}

export function formatCliNoAvailableModelsRecovery(
  options: CliNoAvailableModelsRecoveryOptions = {},
): string {
  const configureKeyAction =
    options.configureKeyAction ?? DEFAULT_CONFIGURE_KEY_ACTION;
  return `${startSentence(configureKeyAction)}.`;
}

export function formatCliNoRunnableModelsMessage(
  options: CliNoAvailableModelsRecoveryOptions = {},
): string {
  return `${NO_RUNNABLE_MODEL_ACCESS_COPY}. ${formatCliNoAvailableModelsRecovery(options)}`;
}

/** The kind's label, lower-cased for the terminal's sentence-case rows. */
function formatModelAccessStatus(model: ModelOptionData): string {
  return model.availability === undefined
    ? 'available'
    : MODEL_AVAILABILITY_STATUS[model.availability].label.toLowerCase();
}

/**
 * The picker row's access, naming the coding plan when one pays for the next
 * request (the row's `usageRoute`, decided by the picker).
 */
function formatModelStatusForCli(model: CliModelAccess): string {
  const route = model.usageRoute;
  return route === 'kimi-code-subscription' ||
    route === 'glm-coding-plan-subscription'
    ? `api: ${formatCliModelAccessRoute(route)}`
    : `api: ${model.status}`;
}

// Reason a given model id cannot be switched to right now, or undefined if it can.
export type GetModelSwitchDisabledReason = (
  model: string,
) => Effect.Effect<string | undefined, Error>;

export function modelSelectItemsForCli(
  models: readonly CliModelAccess[],
  getModelSwitchDisabledReason?: GetModelSwitchDisabledReason,
) {
  return Effect.forEach(runnableCliModelAccessEntries(models), (model) =>
    Effect.gen(function* () {
      const disabledReason = getModelSwitchDisabledReason
        ? yield* getModelSwitchDisabledReason(model.model.value)
        : undefined;
      const access = formatModelStatusForCli(model);
      const status = model.model.reasoning
        ? `${access} · reasoning setting: ${model.model.reasoning}`
        : access;
      return {
        value: model.model.value,
        label: model.model.label || model.model.value,
        description: disabledReason ? `${disabledReason}; ${status}` : status,
        disabled: disabledReason != null,
      } satisfies CliModelPickerItem;
    }),
  );
}

/** Each option's picker row, with the plan its route pays through. */
function cliModelAccessFrom(options: readonly ModelOption[]): CliModelAccess[] {
  const routes = new Map(options.map((option) => [option.model, option]));
  return modelOptionsFrom(options).map((model) => ({
    model,
    available: isModelOptionAvailable(model),
    status: formatModelAccessStatus(model),
    usageRoute: routes.get(model.value)?.usageRoute,
  }));
}

export const getCliModelAccessList = Effect.fn('getCliModelAccessList')(
  function* (options: CliModelAccessListOptions) {
    return cliModelAccessFrom(
      yield* readModelOptions(options.stores, options.models),
    );
  },
);

function findCliModelAccessEntry(
  models: readonly CliModelAccess[],
  model: string,
): CliModelAccess | undefined {
  const exact = models.find((entry) => entry.model.value === model);
  if (exact) return exact;

  const lower = model.toLowerCase();
  const lowerMatch = models.find(
    (entry) => entry.model.value.toLowerCase() === lower,
  );
  if (lowerMatch) return lowerMatch;

  const canonical = resolveKnownCliModelId(model);
  if (!canonical) return undefined;
  return models.find((entry) => entry.model.value === canonical);
}

/**
 * Output projection for JSON/NDJSON: the model id is addressable under the
 * same key (`.id`) as every other CLI resource (`agents`, `team`,
 * `history`).
 *
 * The record is the whole of `ModelOptionData`, so it follows that schema: at
 * 1.0 the fanned-out `availabilityLabel`, `requiresKey` and `disabled` keys are
 * gone and `availability` (the machine-readable kind) is what a consumer reads;
 * the human label for a kind lives in `MODEL_AVAILABILITY_STATUS`.
 */
export function cliModelRecord(
  model: ModelOptionData,
): { id: string } & Omit<ModelOptionData, 'value'> {
  const { value, ...rest } = model;
  return { id: value, ...rest };
}

export function listableModelAccessEntries(
  models: readonly CliModelAccess[],
  options: CliModelListOptions = {},
): readonly CliModelAccess[] {
  if (options.includeUnavailable === true) return models;
  return runnableCliModelAccessEntries(models);
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
    formatCliNoAvailableModelsRecovery(),
  ].join('\n');
}

function formatCliModelRecovery(entry: CliModelAccess): string | undefined {
  if (entry.available) return undefined;

  const availability = entry.model.availability;

  switch (availability) {
    case 'missing-key':
      return formatCliNoAvailableModelsRecovery();
    case 'key-unreadable':
      return 'The API key could not be read from secret storage: check that the store is unlocked and readable, then retry.';
    case 'provider-key':
      return undefined;
    case 'retired':
      return 'Choose an active model.';
    case 'unserved':
      return 'Only OpenRouter or GitHub Copilot serves this model, which TeXRA no longer supports: choose another model.';
    case 'subscription-access':
    case 'xai-subscription-access':
    case undefined:
      return undefined;
    case 'unknown-model':
      return 'Choose a model that is available in the current registry.';
    default:
      return absurd(availability);
  }
}

export function formatCliModelDetails(entry: CliModelAccess): string {
  const { model, status } = entry;
  const lines: string[] = [];
  lines.push(`id: ${model.value}`);
  lines.push(`label: ${model.label}`);
  if (model.provider) lines.push(`provider: ${model.provider}`);
  lines.push(`status: ${status}`);
  if (model.availability)
    lines.push(
      `availability: ${MODEL_AVAILABILITY_STATUS[model.availability].label}`,
    );
  const recovery = formatCliModelRecovery(entry);
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
  const models: readonly CliModelAccess[] =
    options.accessList ??
    (yield* getCliModelAccessList({ stores: options.stores }));
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

    const [hiddenEntry] = cliModelAccessFrom(
      yield* readModelOptions(options.stores, [hiddenModelId]),
    );
    if (!hiddenEntry) {
      return yield* Effect.fail(
        new Error(
          `Model "${hiddenModelId}" is configured but has no option data.`,
        ),
      );
    }

    return hiddenEntry;
  },
);

type CliAvailableModelsMessageOptions = Pick<
  CliRunnableModelOptions,
  'noAvailableModelsMessage'
>;

function formatAvailableModels(
  ids: readonly string[],
  options: CliAvailableModelsMessageOptions,
): string {
  if (ids.length > 0) return `Available models: ${ids.join(', ')}.`;
  const recoveryMessage =
    options.noAvailableModelsMessage ?? formatCliNoAvailableModelsRecovery();
  return `No models are currently available. ${recoveryMessage}`;
}

function formatUnavailableModelMessage(
  model: string,
  entry: CliModelAccess | undefined,
  availableIds: readonly string[],
  options: CliAvailableModelsMessageOptions,
): string {
  const status = entry ? ` (${entry.status})` : '';
  return `Model "${model}" is not available${status}. ${formatAvailableModels(availableIds, options)}`;
}

type NormalizedCliModelCandidate = RunModelCandidate & {
  readonly model: string;
};

/**
 * Each candidate's `reason` owns its unavailable-model fallback behavior
 * (`CLI_MODEL_FALLBACK_MODE_BY_REASON`) unless it names its own
 * `fallbackMode`.
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
        return model
          ? [
              {
                ...candidate,
                model,
                fallbackMode:
                  candidate.fallbackMode ??
                  CLI_MODEL_FALLBACK_MODE_BY_REASON[candidate.reason],
              },
            ]
          : [];
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
        !findCliModelAccessEntry(modelsWithHiddenEntry, entry.model.value)
      ) {
        modelsWithHiddenEntry = [...modelsWithHiddenEntry, entry];
      }
    }
    const runnableEntries = runnableCliModelAccessEntries(
      modelsWithHiddenEntry,
    );
    const availableIds = runnableEntries.map((entry) => entry.model.value);
    const decision = decideRunModel(
      [
        ...requestedCandidates,
        { model: availableIds[0], reason: 'access-list-default' },
      ],
      (candidate) =>
        findCliModelAccessEntry(runnableEntries, candidate) != null,
    );

    if (decision && !decision.unavailable) {
      const selectedModel =
        findCliModelAccessEntry(runnableEntries, decision.model)?.model.value ??
        decision.model;
      if (!decision.fallbackFrom || decision.fallbackFrom.mode === 'silent') {
        return { model: selectedModel } satisfies CliRunnableModelResolution;
      }

      const fallbackLoadError = entryErrorByModel.get(
        decision.fallbackFrom.model,
      );
      if (fallbackLoadError) return yield* Effect.fail(fallbackLoadError);

      const unavailableMessage = formatUnavailableModelMessage(
        decision.fallbackFrom.model,
        findCliModelAccessEntry(
          modelsWithHiddenEntry,
          decision.fallbackFrom.model,
        ),
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
    if (selectedLoadError) return yield* Effect.fail(selectedLoadError);

    const requestedModel =
      (decision?.model ?? requestedCandidates[0]?.model) || '<empty>';
    const unavailableMessage = formatUnavailableModelMessage(
      requestedModel,
      findCliModelAccessEntry(modelsWithHiddenEntry, requestedModel),
      availableIds,
      options,
    );
    return yield* Effect.fail(new Error(unavailableMessage));
  },
);
