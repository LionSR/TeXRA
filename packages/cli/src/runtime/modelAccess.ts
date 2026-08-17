// Local imports
import { computeModelOptionsData } from '@model/computeModelOptions';
import {
  decideRunModel,
  type RunModelCandidate,
  type RunModelDecisionReason,
} from '@model/runModelDecision';
import type {
  ApiAccessMode,
  ModelAvailabilityKind,
  ModelOptionData,
} from '@shared/schemas';
import { isModelOptionAvailable } from '@shared/schemas';
import { INCLUDED_ACCESS, OWN_API_KEYS } from '@shared/copy/modelAccess';
import { assertNever, unique } from '@utils/core';
import { getGLMCodingPlan } from '@utils/config/providerConfig';

// Local file imports
import { resolveKnownCliModelId } from './cliConfig';

export interface CliModelAccess {
  readonly model: ModelOptionData;
  /** Runnable in the API mode used to load this access list. */
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
  readonly apiMode?: ApiAccessMode;
  readonly models?: readonly string[];
}

export interface CliModelAccessEntryOptions extends CliModelAccessListOptions {
  /** Optional preloaded list, used by commands that already fetched access. */
  readonly accessList?: readonly CliModelAccess[];
}

export interface CliRunnableModelOptions extends Pick<
  CliModelAccessEntryOptions,
  'apiMode' | 'accessList'
> {
  /** Decision reason that owns unavailable-model fallback behavior. */
  readonly fallbackReason?: RunModelDecisionReason;
  readonly noAvailableModelsMessage?: string;
}

export interface CliModelListOptions {
  readonly includeUnavailable?: boolean;
}

export interface CliNoAvailableModelsRecoveryOptions {
  readonly includedModeAction?: string;
  readonly loginAction?: string;
  readonly personalModeAction?: string;
  readonly configureKeyAction?: string;
}

export type NoRunnableModelAccessReason =
  ApiAccessMode | 'includedLoginRequired';

const CLI_MODEL_AVAILABILITY_BY_API_MODE = {
  // The ChatGPT subscription is the user's own credential, and the Codex
  // routing overrides the relay/personal credential either way, so a
  // subscription model is runnable in both API modes.
  included: new Set<ModelAvailabilityKind>([
    'included-access',
    'subscription-access',
  ]),
  personal: new Set<ModelAvailabilityKind>([
    'provider-key',
    'openrouter-key',
    'subscription-access',
  ]),
} satisfies Record<ApiAccessMode, ReadonlySet<ModelAvailabilityKind>>;

const INCLUDED = INCLUDED_ACCESS.inline;

const INCLUDED_ACCESS_STATUS_BY_AVAILABILITY = {
  'included-access': `${INCLUDED}: available`,
  'not-included': `${INCLUDED}: unavailable`,
  'included-login-required': `${INCLUDED}: sign-in required`,
  'relay-quota-exhausted': `${INCLUDED}: usage limit reached`,
  'provider-key': `${INCLUDED}: unavailable; API key set`,
  'openrouter-key': `${INCLUDED}: unavailable; OpenRouter key set`,
  'missing-key': `${INCLUDED}: unavailable; missing API key`,
  'subscription-access': 'ChatGPT subscription',
  'copilot-access': 'copilot: unavailable in CLI',
  'copilot-consent-required': 'copilot: unavailable in CLI',
  'copilot-unavailable': 'copilot: unavailable in CLI',
  'provider-unavailable': 'unavailable through selected provider',
  retired: 'retired',
  'unknown-model': 'unknown model',
} satisfies Record<ModelAvailabilityKind, string>;

/** One statement per reason; the launcher shows it bare, messages add a period. */
const NO_RUNNABLE_MODEL_ACCESS_COPY = {
  includedLoginRequired: `Sign in to use ${INCLUDED}`,
  included: `No models are available with ${INCLUDED}`,
  personal: `No models are available with ${OWN_API_KEYS.inline}`,
} satisfies Record<NoRunnableModelAccessReason, string>;

const DEFAULT_CLI_MODEL_RECOVERY_ACTIONS = {
  includedModeAction: 'retry with `--api-mode included`',
  loginAction: 'run `texra login`',
  personalModeAction: 'retry with `--api-mode personal`',
  // Point shell users at the guided setup picker rather than leaving them to
  // figure out key storage on their own; TUI contexts override this with
  // slash-command phrasing.
  configureKeyAction: 'add a provider API key with `texra setup`',
} satisfies Required<CliNoAvailableModelsRecoveryOptions>;

function startSentence(text: string): string {
  if (text.length === 0) return text;
  return `${text.at(0)!.toUpperCase()}${text.slice(1)}`;
}

function cliModelRecoveryActions(
  options: CliNoAvailableModelsRecoveryOptions,
): Required<CliNoAvailableModelsRecoveryOptions> {
  return {
    includedModeAction:
      options.includedModeAction ??
      DEFAULT_CLI_MODEL_RECOVERY_ACTIONS.includedModeAction,
    loginAction:
      options.loginAction ?? DEFAULT_CLI_MODEL_RECOVERY_ACTIONS.loginAction,
    personalModeAction:
      options.personalModeAction ??
      DEFAULT_CLI_MODEL_RECOVERY_ACTIONS.personalModeAction,
    configureKeyAction:
      options.configureKeyAction ??
      DEFAULT_CLI_MODEL_RECOVERY_ACTIONS.configureKeyAction,
  };
}

function isCliModelOptionAllowedInMode(
  model: ModelOptionData,
  apiMode?: ApiAccessMode,
): boolean {
  if (apiMode == null) return true;

  const availability = model.availability;
  return (
    availability != null &&
    CLI_MODEL_AVAILABILITY_BY_API_MODE[apiMode].has(availability)
  );
}

function isCliModelOptionRunnableInMode(
  model: ModelOptionData,
  apiMode?: ApiAccessMode,
): boolean {
  return (
    isModelOptionAvailable(model) &&
    isCliModelOptionAllowedInMode(model, apiMode)
  );
}

export function runnableCliModelAccessEntries(
  models: readonly CliModelAccess[],
  apiMode?: ApiAccessMode,
): CliModelAccess[] {
  return models.filter(
    (entry) =>
      entry.available && isCliModelOptionAllowedInMode(entry.model, apiMode),
  );
}

export function noRunnableModelAccessReason(
  models: readonly CliModelAccess[],
  apiMode: ApiAccessMode,
): NoRunnableModelAccessReason {
  if (
    apiMode === 'included' &&
    models.some(
      (model) => model.model.availability === 'included-login-required',
    )
  ) {
    return 'includedLoginRequired';
  }
  return apiMode;
}

function formatCliNoRunnableModelsRecovery(
  reason: NoRunnableModelAccessReason,
  options: CliNoAvailableModelsRecoveryOptions = {},
): string {
  const {
    includedModeAction,
    loginAction,
    personalModeAction,
    configureKeyAction,
  } = cliModelRecoveryActions(options);

  if (reason === 'includedLoginRequired') {
    return `${startSentence(loginAction)} or ${personalModeAction}.`;
  }
  if (reason === 'included') {
    return `${startSentence(personalModeAction)} or try again later.`;
  }
  return `${startSentence(configureKeyAction)} or ${includedModeAction}.`;
}

export function formatCliNoRunnableModelsMessage(
  reason: NoRunnableModelAccessReason,
  options: CliNoAvailableModelsRecoveryOptions = {},
): string {
  return `${NO_RUNNABLE_MODEL_ACCESS_COPY[reason]}. ${formatCliNoRunnableModelsRecovery(reason, options)}`;
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

export function formatModelStatusForCliMode(
  model: CliModelAccess,
  apiMode: ApiAccessMode,
): string {
  if (apiMode === 'personal') {
    if (model.model.provider === 'kimiCode')
      return 'api: Kimi Code subscription';
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

  const availability = model.model.availability;
  if (availability == null) return `${INCLUDED}: ${model.status}`;
  // Prefer the availability label for subscription rows so Grok OAuth is not
  // hard-coded as "chatgpt subscription" (kind is shared with ChatGPT).
  if (availability === 'subscription-access') {
    return model.status;
  }
  return INCLUDED_ACCESS_STATUS_BY_AVAILABILITY[availability];
}

// Reason a given model id cannot be switched to right now, or undefined if it can.
export type GetModelSwitchDisabledReason = (
  model: string,
) => string | undefined;

export function modelSelectItemsForCliMode(
  models: readonly CliModelAccess[],
  apiMode: ApiAccessMode,
  getModelSwitchDisabledReason?: GetModelSwitchDisabledReason,
): readonly CliModelPickerItem[] {
  return runnableCliModelAccessEntries(models, apiMode).map((model) => {
    const disabledReason = getModelSwitchDisabledReason?.(model.model.value);
    const status = formatModelStatusForCliMode(model, apiMode);
    return {
      value: model.model.value,
      label: model.model.label || model.model.value,
      description: disabledReason ? `${disabledReason}; ${status}` : status,
      disabled: disabledReason != null,
    };
  });
}

export function modelAccessLaunchBlockDescriptionForCliMode(
  models: readonly CliModelAccess[],
  apiMode: ApiAccessMode,
): string {
  return NO_RUNNABLE_MODEL_ACCESS_COPY[
    noRunnableModelAccessReason(models, apiMode)
  ];
}

export function emptyModelListMessageForCliMode(
  models: readonly CliModelAccess[],
  apiMode: ApiAccessMode,
  options: CliNoAvailableModelsRecoveryOptions = {},
): string {
  return formatCliNoRunnableModelsMessage(
    noRunnableModelAccessReason(models, apiMode),
    options,
  );
}

export function formatCliNoAvailableModelsRecovery(
  apiMode?: ApiAccessMode,
  options: CliNoAvailableModelsRecoveryOptions = {},
): string {
  const {
    includedModeAction,
    loginAction,
    personalModeAction,
    configureKeyAction,
  } = cliModelRecoveryActions(options);

  if (apiMode === 'personal') {
    return `${startSentence(configureKeyAction)}, or ${includedModeAction} and ${loginAction}.`;
  }
  if (apiMode === 'included') {
    return `${startSentence(loginAction)} for ${INCLUDED}, or ${personalModeAction} after configuring a provider API key.`;
  }
  return `${startSentence(loginAction)}, ${includedModeAction}, or ${configureKeyAction}.`;
}

function toCliModelAccess(
  model: ModelOptionData,
  apiMode?: ApiAccessMode,
): CliModelAccess {
  return {
    model,
    available: isCliModelOptionRunnableInMode(model, apiMode),
    status: formatModelAccessStatus(model),
  };
}

export async function getCliModelAccessList(
  options: CliModelAccessListOptions = {},
): Promise<CliModelAccess[]> {
  const models = await computeModelOptionsData(options.models);
  return models.map((model) => toCliModelAccess(model, options.apiMode));
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
 * Output projection for JSON/NDJSON: prefix the model record with `id` so the
 * model id is addressable under the same key (`.id`) as every other CLI
 * resource (`agents`, `multi-agent`, `history`). `value` is kept for backward
 * compatibility with existing scripts.
 */
export function cliModelRecord(
  model: ModelOptionData,
): { id: string } & ModelOptionData {
  return { id: model.value, ...model };
}

export function listableModelAccessEntries(
  models: readonly CliModelAccess[],
  options: CliModelListOptions = {},
): readonly CliModelAccess[] {
  if (options.includeUnavailable === true) return models;
  return runnableCliModelAccessEntries(models);
}

export function formatNoListableModelsMessage(
  apiMode: ApiAccessMode | undefined,
  options: CliModelListOptions = {},
): string {
  return [
    'No models are currently available.',
    ...(options.includeUnavailable === true
      ? []
      : [
          'Run `texra models list --all` to see unavailable models and access status.',
        ]),
    formatCliNoAvailableModelsRecovery(apiMode),
  ].join('\n');
}

function formatCliModelRecovery(
  entry: CliModelAccess,
  apiMode: ApiAccessMode | undefined,
): string | undefined {
  if (entry.available) return undefined;

  const {
    includedModeAction,
    loginAction,
    personalModeAction,
    configureKeyAction,
  } = DEFAULT_CLI_MODEL_RECOVERY_ACTIONS;

  const availability = entry.model.availability;

  switch (availability) {
    case 'included-login-required':
      return apiMode === 'personal'
        ? `${startSentence(loginAction)} for ${INCLUDED}, then ${includedModeAction}.`
        : `${startSentence(loginAction)} for ${INCLUDED}, or ${personalModeAction} after configuring a provider API key.`;
    case 'relay-quota-exhausted':
      return apiMode === 'personal'
        ? 'Retry later.'
        : `Retry later, or ${personalModeAction} after configuring a provider API key.`;
    case 'missing-key':
      return apiMode === 'personal'
        ? `${startSentence(configureKeyAction)}, or ${loginAction} and ${includedModeAction} if your plan covers this model.`
        : `${startSentence(configureKeyAction)}, then ${personalModeAction}.`;
    case 'provider-key':
    case 'openrouter-key':
      return apiMode === 'included'
        ? `${startSentence(personalModeAction)}.`
        : undefined;
    case 'included-access':
      return apiMode === 'personal'
        ? `${startSentence(includedModeAction)}.`
        : undefined;
    case 'not-included':
      return apiMode === 'personal'
        ? `${startSentence(configureKeyAction)}.`
        : `${startSentence(configureKeyAction)}, then ${personalModeAction}.`;
    case 'retired':
      return 'Choose an active model.';
    case 'provider-unavailable':
      return 'Choose a supported provider route or another model.';
    case 'subscription-access':
    case 'copilot-access':
      return undefined;
    case 'copilot-consent-required':
      return 'Use this model in VS Code through GitHub Copilot, or choose another model.';
    case 'copilot-unavailable':
      return 'Use this model in VS Code through GitHub Copilot, or choose another model.';
    case 'unknown-model':
      return 'Choose a model that is available in the current registry.';
    case undefined:
      return undefined;
    default:
      return assertNever(availability, 'Unhandled model availability');
  }
}

export function formatCliModelDetails(
  entry: CliModelAccess,
  apiMode?: ApiAccessMode,
): string {
  const { model, status } = entry;
  const lines: string[] = [];
  lines.push(`id: ${model.value}`);
  lines.push(`label: ${model.label}`);
  if (model.provider) lines.push(`provider: ${model.provider}`);
  lines.push(`status: ${status}`);
  if (model.availabilityLabel)
    lines.push(`availability: ${model.availabilityLabel}`);
  const recovery = formatCliModelRecovery(entry, apiMode);
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
  return (
    options.accessList ??
    getCliModelAccessList({
      apiMode: options.apiMode,
    })
  );
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

  return toCliModelAccess(hiddenModelOption, options.apiMode);
}

type CliAvailableModelsMessageOptions = Pick<
  CliRunnableModelOptions,
  'apiMode' | 'noAvailableModelsMessage'
>;

function formatAvailableModels(
  ids: readonly string[],
  options: CliAvailableModelsMessageOptions,
): string {
  if (ids.length > 0) return `Available models: ${ids.join(', ')}.`;
  const recoveryMessage =
    options.noAvailableModelsMessage ??
    formatCliNoAvailableModelsRecovery(options.apiMode);
  return `No models are currently available. ${recoveryMessage}`;
}

function formatUnavailableModelMessage(
  model: string,
  entry: CliModelAccess | undefined,
  availableIds: readonly string[],
  options: CliAvailableModelsMessageOptions,
): string {
  const status = entry ? ` (${entry.status})` : '';
  return `Model "${model}" is not available in the active API mode${status}. ${formatAvailableModels(availableIds, options)}`;
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
        apiMode: options.apiMode,
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
  const runnableEntries = runnableCliModelAccessEntries(
    modelsWithHiddenEntry,
    options.apiMode,
  );
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
