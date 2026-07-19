// Local imports
import { SupabaseClient } from '@auth/SupabaseClient';
import { computeModelOptionsData } from '@model/computeModelOptions';
import {
  decideRunModel,
  type RunModelCandidate,
  type RunModelDecisionReason,
} from '@model/runModelDecision';
import type { ModelAvailabilityKind, ModelOptionData } from '@shared/schemas';
import type { AgentCategory } from '@shared/schemas/agent';

// Local file imports
import { resolveKnownCliModelId } from './cliConfig';
import type { CliApiMode } from './apiAccessMode';

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
  readonly apiMode?: CliApiMode;
  readonly models?: readonly string[];
  readonly agentCategory?: AgentCategory;
}

export interface CliModelAccessEntryOptions extends CliModelAccessListOptions {
  /** Optional preloaded list, used by commands that already fetched access. */
  readonly accessList?: readonly CliModelAccess[];
}

export interface CliRunnableModelOptions extends Pick<
  CliModelAccessEntryOptions,
  'apiMode' | 'agentCategory' | 'accessList'
> {
  /** Decision reason that owns unavailable-model fallback behavior. */
  readonly fallbackReason?: RunModelDecisionReason;
  readonly noAvailableModelsMessage?: string;
}

function computeCliModelOptionsData(
  models: readonly string[] | undefined,
  agentCategory: AgentCategory | undefined,
): Promise<ModelOptionData[]> {
  return computeModelOptionsData(models, undefined, { agentCategory });
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

export type CliNoRunnableModelsMessageOptions =
  CliNoAvailableModelsRecoveryOptions;

export type NoRunnableModelAccessReason = CliApiMode | 'includedLoginRequired';

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
} satisfies Record<CliApiMode, ReadonlySet<ModelAvailabilityKind>>;

const INCLUDED_ACCESS_STATUS_BY_AVAILABILITY = {
  'included-access': 'included: available',
  'not-included': 'included: unavailable',
  'included-login-required': 'included: sign-in required',
  'relay-quota-exhausted': 'included: usage limit reached',
  'provider-key': 'included: unavailable; API key set',
  'openrouter-key': 'included: unavailable; OpenRouter key set',
  'missing-key': 'included: unavailable; missing API key',
  'subscription-access': 'chatgpt subscription',
  'copilot-access': 'copilot: unavailable in CLI',
  'copilot-consent-required': 'copilot: unavailable in CLI',
  'copilot-unavailable': 'copilot: unavailable in CLI',
  'provider-unavailable': 'unavailable through selected provider',
  retired: 'retired',
} satisfies Record<ModelAvailabilityKind, string>;

const NO_RUNNABLE_MODEL_ACCESS_COPY = {
  includedLoginRequired: {
    launchBlock: 'Sign in with texra login for included TeXRA models',
    summary: 'Included TeXRA models require sign-in.',
  },
  included: {
    launchBlock: 'No included TeXRA models are runnable',
    summary: 'No included TeXRA models are runnable.',
  },
  personal: {
    launchBlock: 'No personal API-key models are runnable',
    summary: 'No personal API-key models are runnable.',
  },
} satisfies Record<
  NoRunnableModelAccessReason,
  { readonly launchBlock: string; readonly summary: string }
>;

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
  options: CliNoAvailableModelsRecoveryOptions = {},
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

function isCliModelOptionBasicallyAvailable(model: ModelOptionData): boolean {
  return model.disabled !== true && model.requiresKey !== true;
}

function isCliModelOptionAllowedInMode(
  model: ModelOptionData,
  apiMode?: CliApiMode,
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
  apiMode?: CliApiMode,
): boolean {
  return (
    isCliModelOptionBasicallyAvailable(model) &&
    isCliModelOptionAllowedInMode(model, apiMode)
  );
}

export function runnableCliModelAccessEntries(
  models: readonly CliModelAccess[],
  apiMode?: CliApiMode,
): CliModelAccess[] {
  return models.filter(
    (entry) =>
      entry.available && isCliModelOptionAllowedInMode(entry.model, apiMode),
  );
}

export function noRunnableModelAccessReason(
  models: readonly CliModelAccess[],
  apiMode: CliApiMode,
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

export function formatCliNoRunnableModelsLaunchBlock(
  reason: NoRunnableModelAccessReason,
): string {
  return NO_RUNNABLE_MODEL_ACCESS_COPY[reason].launchBlock;
}

function formatCliNoRunnableModelsRecovery(
  reason: NoRunnableModelAccessReason,
  options: CliNoRunnableModelsMessageOptions = {},
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
  options: CliNoRunnableModelsMessageOptions = {},
): string {
  return `${NO_RUNNABLE_MODEL_ACCESS_COPY[reason].summary} ${formatCliNoRunnableModelsRecovery(reason, options)}`;
}

function formatModelAccessStatus(model: ModelOptionData): string {
  if (model.availabilityLabel) return model.availabilityLabel.toLowerCase();
  if (!model.disabled && !model.requiresKey) return 'available';
  if (model.requiresKey) {
    const provider = model.provider ? `${model.provider} ` : '';
    return `missing ${provider}key`;
  }
  return 'unavailable';
}

export function formatModelStatusForCliMode(
  model: CliModelAccess,
  apiMode: CliApiMode,
): string {
  if (apiMode === 'personal') return `api: ${model.status}`;

  const availability = model.model.availability;
  if (availability == null) return `included: ${model.status}`;
  return INCLUDED_ACCESS_STATUS_BY_AVAILABILITY[availability];
}

// Reason a given model id cannot be switched to right now, or undefined if it can.
export type GetModelSwitchDisabledReason = (
  model: string,
) => string | undefined;

export function modelSelectItemsForCliMode(
  models: readonly CliModelAccess[],
  apiMode: CliApiMode,
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
  apiMode: CliApiMode,
): string {
  return formatCliNoRunnableModelsLaunchBlock(
    noRunnableModelAccessReason(models, apiMode),
  );
}

export function emptyModelListMessageForCliMode(
  models: readonly CliModelAccess[],
  apiMode: CliApiMode,
  options: CliNoRunnableModelsMessageOptions = {},
): string {
  return formatCliNoRunnableModelsMessage(
    noRunnableModelAccessReason(models, apiMode),
    options,
  );
}

export function formatCliNoAvailableModelsRecovery(
  apiMode?: CliApiMode,
  options: CliNoAvailableModelsRecoveryOptions = {},
): string {
  const {
    includedModeAction,
    loginAction,
    personalModeAction,
    configureKeyAction,
  } = cliModelRecoveryActions(options);

  if (apiMode === 'personal') {
    return `${startSentence(configureKeyAction)} for personal mode, or ${includedModeAction} and ${loginAction} for included TeXRA access.`;
  }
  if (apiMode === 'included') {
    return `${startSentence(loginAction)} for included TeXRA access, or ${personalModeAction} after configuring a provider API key.`;
  }
  return `${startSentence(loginAction)} for included TeXRA access, ${includedModeAction}, or ${configureKeyAction}.`;
}

function toCliModelAccess(
  model: ModelOptionData,
  apiMode?: CliApiMode,
): CliModelAccess {
  return {
    model,
    available: isCliModelOptionRunnableInMode(model, apiMode),
    status: formatModelAccessStatus(model),
  };
}

function toIncludedLoginRequiredAccess(entry: CliModelAccess): CliModelAccess {
  if (
    entry.model.availability === 'subscription-access' ||
    entry.model.availability === 'retired'
  ) {
    return entry;
  }
  return {
    model: {
      ...entry.model,
      availability: 'included-login-required',
      availabilityLabel: 'Login required',
      requiresKey: false,
      disabled: true,
    },
    available: false,
    status: 'login required',
  };
}

async function includedAccessRequiresLogin(
  options: CliModelAccessListOptions,
): Promise<boolean> {
  if (options.apiMode !== 'included') return false;
  // An auth-state read failure means we can't prove a session, so require login.
  const authenticated = await SupabaseClient.isAuthenticated().catch(
    () => false,
  );
  return !authenticated;
}

export async function getCliModelAccessList(
  options: CliModelAccessListOptions = {},
): Promise<CliModelAccess[]> {
  const models = await computeCliModelOptionsData(
    options.models,
    options.agentCategory,
  );
  const access = models.map((model) =>
    toCliModelAccess(model, options.apiMode),
  );
  if (await includedAccessRequiresLogin(options)) {
    return access.map(toIncludedLoginRequiredAccess);
  }
  return access;
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
  apiMode: CliApiMode | undefined,
  options: CliModelListOptions = {},
): string {
  const statusHint =
    options.includeUnavailable === true
      ? 'No model records were returned for this installation.'
      : 'Run `texra models list --all` to see unavailable models and access status.';
  return [
    'No models are currently available.',
    statusHint,
    formatCliNoAvailableModelsRecovery(apiMode),
  ].join('\n');
}

function formatCliModelRecovery(
  entry: CliModelAccess,
  apiMode: CliApiMode | undefined,
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
        ? `${startSentence(loginAction)} for included TeXRA access, then ${includedModeAction}.`
        : `${startSentence(loginAction)} for included TeXRA access, or ${personalModeAction} after configuring a provider API key.`;
    case 'relay-quota-exhausted':
      return apiMode === 'personal'
        ? 'Retry later.'
        : `Retry later, or ${personalModeAction} after configuring a provider API key.`;
    case 'missing-key':
      return apiMode === 'personal'
        ? `${startSentence(configureKeyAction)} for personal mode, or ${loginAction} and ${includedModeAction} if this model is included.`
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
        ? `${startSentence(configureKeyAction)} for personal mode.`
        : `${startSentence(configureKeyAction)}, then ${personalModeAction}.`;
    case 'retired':
      return 'Choose an active model.';
    case 'provider-unavailable':
      return 'Choose a supported provider route or another model.';
    default:
      return undefined;
  }
}

export function formatCliModelDetails(
  entry: CliModelAccess,
  apiMode?: CliApiMode,
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

function modelIds(models: readonly CliModelAccess[]): string[] {
  return models.map((entry) => entry.model.value);
}

function withModelAccess(
  models: readonly CliModelAccess[],
  entry: CliModelAccess | undefined,
): readonly CliModelAccess[] {
  if (!entry || findCliModelAccessEntry(models, entry.model.value)) {
    return models;
  }
  return [...models, entry];
}

async function loadCliModelAccessList(
  options: CliModelAccessEntryOptions,
): Promise<readonly CliModelAccess[]> {
  return (
    options.accessList ??
    getCliModelAccessList({
      apiMode: options.apiMode,
      agentCategory: options.agentCategory,
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

  const hiddenModelOption = (
    await computeCliModelOptionsData([hiddenModelId], options.agentCategory)
  )[0];
  if (!hiddenModelOption) {
    throw new Error(
      `Model "${hiddenModelId}" is configured but has no option data.`,
    );
  }

  let hiddenModel = toCliModelAccess(hiddenModelOption, options.apiMode);
  if (await includedAccessRequiresLogin(options)) {
    hiddenModel = toIncludedLoginRequiredAccess(hiddenModel);
  }
  return hiddenModel;
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
  const requestedModels = [
    ...new Set(requestedCandidates.map((candidate) => candidate.model)),
  ];
  const hiddenEntries = await Promise.allSettled(
    requestedModels.map((model) =>
      loadCliModelAccessEntry(model, {
        apiMode: options.apiMode,
        agentCategory: options.agentCategory,
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
      modelsWithHiddenEntry = withModelAccess(
        modelsWithHiddenEntry,
        result.value,
      );
    } else {
      entryErrorByModel.set(model, result.reason);
    }
  }
  const runnableEntries = runnableCliModelAccessEntries(
    modelsWithHiddenEntry,
    options.apiMode,
  );
  const availableIds = modelIds(runnableEntries);
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
