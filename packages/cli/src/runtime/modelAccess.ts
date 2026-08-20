// Local imports
import { computeModelOptionsData } from '@model/computeModelOptions';
import {
  decideRunModel,
  type RunModelCandidate,
  type RunModelDecisionReason,
} from '@model/runModelDecision';
import type { ModelOptionData } from '@shared/schemas';
import { isModelOptionAvailable } from '@shared/schemas';
import { assertNever, unique } from '@utils/core';
import { getGLMCodingPlan } from '@utils/config/providerConfig';

// Local file imports
import { resolveKnownCliModelId } from './cliConfig';

export interface CliModelAccess {
  readonly model: ModelOptionData;
  /** Runnable with the currently configured credentials. */
  readonly available: boolean;
  readonly status: string;
}

export interface CliModelPickerItem {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
}

export interface CliRunnableModelResolution {
  readonly model: string;
  readonly notice?: string;
}

type CliModelFallbackMode = 'reject' | 'notice' | 'silent';

const CLI_MODEL_FALLBACK_MODE_BY_REASON = {
  'explicit-override': 'reject',
  environment: 'reject',
  'agent-config': 'notice',
  'command-config': 'notice',
  'workspace-config': 'notice',
  'user-config': 'notice',
  history: 'notice',
  'parent-run': 'notice',
  'router-config': 'reject',
  credential: 'reject',
  'builtin-default': 'silent',
  'access-list-default': 'silent',
} satisfies Record<RunModelDecisionReason, CliModelFallbackMode>;

export interface CliModelAccessListOptions {
  readonly models?: readonly string[];
}

/**
 * Deliberately does NOT extend {@link CliModelAccessListOptions}:
 * `loadCliModelAccessList` calls `getCliModelAccessList()` with no arguments,
 * so a `models` filter passed here would be silently dropped. Keeping the
 * field off the type makes that unrepresentable rather than ignored.
 */
export interface CliModelAccessEntryOptions {
  /** Optional preloaded list, used by commands that already fetched access. */
  readonly accessList?: readonly CliModelAccess[];
}

export interface CliRunnableModelOptions extends Pick<
  CliModelAccessEntryOptions,
  'accessList'
> {
  /** Decision reason that owns unavailable-model fallback behavior. */
  readonly fallbackReason?: RunModelDecisionReason;
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

export function runnableCliModelAccessEntries(
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

function formatModelAccessStatus(model: ModelOptionData): string {
  if (model.availabilityLabel) return model.availabilityLabel.toLowerCase();
  if (isModelOptionAvailable(model)) return 'available';
  if (model.requiresKey) {
    const provider = model.provider ? `${model.provider} ` : '';
    return `missing ${provider}key`;
  }
  return 'unavailable';
}

export function formatModelStatusForCli(model: CliModelAccess): string {
  if (model.model.provider === 'kimiCode') return 'api: Kimi Code subscription';
  // GLM models route through the Coding Plan endpoint when the toggle is on.
  // Gate on the resolved provider-key route (not just provider + toggle): the
  // coding-plan path only applies to the direct GLM endpoint, never to an
  // OpenRouter route, which stays reported as its own key status.
  if (
    model.model.provider === 'glm' &&
    model.model.availability === 'provider-key' &&
    getGLMCodingPlan()
  ) {
    return 'api: GLM Coding Plan';
  }
  return `api: ${model.status}`;
}

// Reason a given model id cannot be switched to right now, or undefined if it can.
export type GetModelSwitchDisabledReason = (
  model: string,
) => string | undefined;

export function modelSelectItemsForCli(
  models: readonly CliModelAccess[],
  getModelSwitchDisabledReason?: GetModelSwitchDisabledReason,
): readonly CliModelPickerItem[] {
  return runnableCliModelAccessEntries(models).map((model) => {
    const disabledReason = getModelSwitchDisabledReason?.(model.model.value);
    const status = formatModelStatusForCli(model);
    return {
      value: model.model.value,
      label: model.model.label || model.model.value,
      description: disabledReason ? `${disabledReason}; ${status}` : status,
      disabled: disabledReason != null,
    };
  });
}

export function modelAccessLaunchBlockDescription(): string {
  return NO_RUNNABLE_MODEL_ACCESS_COPY;
}

export function emptyModelListMessage(
  options: CliNoAvailableModelsRecoveryOptions = {},
): string {
  return formatCliNoRunnableModelsMessage(options);
}

function toCliModelAccess(model: ModelOptionData): CliModelAccess {
  return {
    model,
    available: isModelOptionAvailable(model),
    status: formatModelAccessStatus(model),
  };
}

export async function getCliModelAccessList(
  options: CliModelAccessListOptions = {},
): Promise<CliModelAccess[]> {
  const models = await computeModelOptionsData(options.models);
  return models.map((model) => toCliModelAccess(model));
}

export function findCliModelAccessEntry(
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
 * same key (`.id`) as every other CLI resource (`agents`, `multi-agent`,
 * `history`).
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
      return `${startSentence(DEFAULT_CONFIGURE_KEY_ACTION)}.`;
    case 'provider-key':
    case 'openrouter-key':
      return undefined;
    case 'retired':
      return 'Choose an active model.';
    case 'provider-unavailable':
      return 'Choose a supported provider route or another model.';
    case 'subscription-access':
    case 'copilot-access':
    case undefined:
      return undefined;
    case 'copilot-consent-required':
    case 'copilot-unavailable':
      return 'Use this model in VS Code through GitHub Copilot, or choose another model.';
    case 'unknown-model':
      return 'Choose a model that is available in the current registry.';
    default:
      return assertNever(availability, 'Unhandled model availability');
  }
}

export function formatCliModelDetails(entry: CliModelAccess): string {
  const { model, status } = entry;
  const lines: string[] = [];
  lines.push(`id: ${model.value}`);
  lines.push(`label: ${model.label}`);
  if (model.provider) lines.push(`provider: ${model.provider}`);
  lines.push(`status: ${status}`);
  if (model.availabilityLabel)
    lines.push(`availability: ${model.availabilityLabel}`);
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

async function loadCliModelAccessList(
  options: CliModelAccessEntryOptions,
): Promise<readonly CliModelAccess[]> {
  return options.accessList ?? getCliModelAccessList();
}

export async function loadCliModelAccessEntry(
  model: string,
  options: CliModelAccessEntryOptions = {},
): Promise<CliModelAccess | undefined> {
  const models = await loadCliModelAccessList(options);
  const trimmed = model.trim();
  const listedEntry = findCliModelAccessEntry(models, trimmed);
  if (listedEntry || trimmed.length === 0) return listedEntry;

  const hiddenModelId = resolveKnownCliModelId(trimmed);
  if (hiddenModelId == null) return undefined;

  const hiddenModelOption = (await computeModelOptionsData([hiddenModelId]))[0];
  if (!hiddenModelOption) {
    throw new Error(
      `Model "${hiddenModelId}" is configured but has no option data.`,
    );
  }

  return toCliModelAccess(hiddenModelOption);
}

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

function rawCliModelDecisionCandidates(
  request: string | readonly RunModelCandidate[],
  options: CliRunnableModelOptions,
): readonly RunModelCandidate[] {
  if (typeof request !== 'string') return request;
  if (!options.fallbackReason) {
    throw new Error('fallbackReason is required for single-model resolution');
  }
  return [{ model: request, reason: options.fallbackReason }];
}

export async function selectCliRunnableModel(
  request: string | readonly RunModelCandidate[],
  options: CliRunnableModelOptions,
): Promise<CliRunnableModelResolution> {
  const models = await loadCliModelAccessList(options);
  const requestedCandidates: NormalizedCliModelCandidate[] =
    rawCliModelDecisionCandidates(request, options).flatMap((candidate) => {
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
  const requestedModels = unique(
    requestedCandidates.map((candidate) => candidate.model),
  );
  const hiddenEntries = await Promise.allSettled(
    requestedModels.map((model) =>
      loadCliModelAccessEntry(model, {
        accessList: models,
      }),
    ),
  );
  const entryErrorByModel = new Map<string, unknown>();
  let modelsWithHiddenEntry = models;
  for (const [index, result] of hiddenEntries.entries()) {
    const model = requestedModels[index];
    if (!model) continue;
    if (result.status === 'fulfilled') {
      const entry = result.value;
      if (
        entry &&
        !findCliModelAccessEntry(modelsWithHiddenEntry, entry.model.value)
      ) {
        modelsWithHiddenEntry = [...modelsWithHiddenEntry, entry];
      }
    } else {
      entryErrorByModel.set(model, result.reason);
    }
  }
  const runnableEntries = runnableCliModelAccessEntries(modelsWithHiddenEntry);
  const availableIds = runnableEntries.map((entry) => entry.model.value);
  const decision = decideRunModel(
    [
      ...requestedCandidates,
      { model: availableIds[0], reason: 'access-list-default' },
    ],
    (candidate) => findCliModelAccessEntry(runnableEntries, candidate) != null,
  );

  if (decision && !decision.unavailable) {
    const selectedModel =
      findCliModelAccessEntry(runnableEntries, decision.model)?.model.value ??
      decision.model;
    if (!decision.fallbackFrom || decision.fallbackFrom.mode === 'silent') {
      return { model: selectedModel };
    }

    const fallbackLoadError = entryErrorByModel.get(
      decision.fallbackFrom.model,
    );
    if (fallbackLoadError) throw fallbackLoadError;

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
    };
  }

  const selectedLoadError = decision
    ? entryErrorByModel.get(decision.model)
    : undefined;
  if (selectedLoadError) throw selectedLoadError;

  const requestedModel =
    (decision?.model ??
      requestedCandidates[0]?.model ??
      (typeof request === 'string' ? request.trim() : '')) ||
    '<empty>';
  const unavailableMessage = formatUnavailableModelMessage(
    requestedModel,
    findCliModelAccessEntry(modelsWithHiddenEntry, requestedModel),
    availableIds,
    options,
  );
  throw new Error(unavailableMessage);
}
