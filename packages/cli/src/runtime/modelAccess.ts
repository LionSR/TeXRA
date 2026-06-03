// Third-party imports
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports - model surfaces
import { computeModelOptionsData } from '@model/computeModelOptions';
import type { ModelAvailabilityKind, ModelOptionData } from '@shared/schemas';

import { getCliAuthProvider } from './supabaseAuth';
import type { CliApiMode } from './apiAccessMode';

export interface CliModelAccess {
  readonly model: ModelOptionData;
  /** Runnable in the API mode used to load this access list. */
  readonly available: boolean;
  readonly status: string;
}

export interface CliRunnableModelResolution {
  readonly model: string;
  readonly notice?: string;
}

export type CliModelFallbackMode = 'reject' | 'notice' | 'silent';

export interface CliRunnableModelOptions {
  readonly fallbackMode: CliModelFallbackMode;
  readonly apiMode?: CliApiMode;
  readonly noAvailableModelsMessage?: string;
}

export type CliModelSelectionSource =
  | 'override'
  | 'env'
  | 'config'
  | 'workspace'
  | 'user'
  | 'history'
  | 'builtin';

const CLI_MODEL_FALLBACK_MODE_BY_SOURCE = {
  override: 'reject',
  env: 'reject',
  config: 'notice',
  workspace: 'notice',
  user: 'notice',
  history: 'notice',
  builtin: 'silent',
} satisfies Record<CliModelSelectionSource, CliModelFallbackMode>;

export interface CliModelAccessListOptions {
  readonly apiMode?: CliApiMode;
}

export interface CliNoAvailableModelsRecoveryOptions {
  readonly includedModeAction?: string;
  readonly personalModeAction?: string;
}

const CLI_MODEL_AVAILABILITY_BY_API_MODE = {
  included: new Set<ModelAvailabilityKind>(['included-access']),
  personal: new Set<ModelAvailabilityKind>(['provider-key', 'openrouter-key']),
} satisfies Record<CliApiMode, ReadonlySet<ModelAvailabilityKind>>;

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

function formatModelAccessStatus(model: ModelOptionData): string {
  if (model.availabilityLabel) return model.availabilityLabel.toLowerCase();
  if (!model.disabled && !model.requiresKey) return 'available';
  if (model.requiresKey) {
    const provider = model.provider ? `${model.provider} ` : '';
    return `missing ${provider}key`;
  }
  return 'unavailable';
}

export function cliModelFallbackModeForSource(
  source: CliModelSelectionSource,
): CliModelFallbackMode {
  return CLI_MODEL_FALLBACK_MODE_BY_SOURCE[source];
}

export function cliRunnableModelOptionsForSource(
  source: CliModelSelectionSource,
  options: Omit<CliRunnableModelOptions, 'fallbackMode'> = {},
): CliRunnableModelOptions {
  return {
    ...options,
    fallbackMode: cliModelFallbackModeForSource(source),
  };
}

export function formatCliNoAvailableModelsRecovery(
  apiMode?: CliApiMode,
  options: CliNoAvailableModelsRecoveryOptions = {},
): string {
  const includedModeAction =
    options.includedModeAction ?? 'retry with `--api-mode included`';
  const personalModeAction =
    options.personalModeAction ?? 'retry with `--api-mode personal`';

  if (apiMode === 'personal') {
    return `Configure a provider API key for personal mode, or ${includedModeAction} and run \`texra login\` for included relay access.`;
  }
  if (apiMode === 'included') {
    return `Run \`texra login\` for included relay access, or ${personalModeAction} after configuring a provider API key.`;
  }
  return `Run \`texra login\` for included relay access, ${includedModeAction}, or configure a provider API key.`;
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
  try {
    return !(await getCliAuthProvider().isAuthenticated());
  } catch {
    return true;
  }
}

export async function getCliModelAccessList(
  options: CliModelAccessListOptions = {},
): Promise<CliModelAccess[]> {
  const models = await computeModelOptionsData();
  const access = models.map((model) =>
    toCliModelAccess(model, options.apiMode),
  );
  if (await includedAccessRequiresLogin(options)) {
    return access.map(toIncludedLoginRequiredAccess);
  }
  return access;
}

function findModelAccess(
  models: readonly CliModelAccess[],
  model: string,
): CliModelAccess | undefined {
  const exact = models.find((entry) => entry.model.value === model);
  if (exact) return exact;

  const lower = model.toLowerCase();
  return models.find((entry) => entry.model.value.toLowerCase() === lower);
}

function modelIds(models: readonly CliModelAccess[]): string[] {
  return models.map((entry) => entry.model.value);
}

function withModelAccess(
  models: readonly CliModelAccess[],
  entry: CliModelAccess | undefined,
): readonly CliModelAccess[] {
  if (!entry || findModelAccess(models, entry.model.value)) return models;
  return [...models, entry];
}

function getCanonicalModelConfigId(model: string): string | undefined {
  if (Object.hasOwn(MODEL_CONFIGS, model)) return model;

  const lower = model.toLowerCase();
  return Object.keys(MODEL_CONFIGS).find((id) => id.toLowerCase() === lower);
}

function formatAvailableModels(
  ids: readonly string[],
  options: Pick<
    CliRunnableModelOptions,
    'apiMode' | 'noAvailableModelsMessage'
  >,
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
  options: Pick<
    CliRunnableModelOptions,
    'apiMode' | 'noAvailableModelsMessage'
  >,
): string {
  const status = entry ? ` (${entry.status})` : '';
  return `Model "${model}" is not available in the active API mode${status}. ${formatAvailableModels(availableIds, options)}`;
}

export function resolveCliRunnableModelFromAccessList(
  models: readonly CliModelAccess[],
  model: string,
  options: CliRunnableModelOptions,
): CliRunnableModelResolution {
  const trimmed = model.trim();
  const runnableEntries = runnableCliModelAccessEntries(
    models,
    options.apiMode,
  );
  const entry = findModelAccess(models, trimmed);
  const runnableEntry = findModelAccess(runnableEntries, trimmed);
  if (runnableEntry) return { model: runnableEntry.model.value };

  const availableIds = modelIds(runnableEntries);
  const unavailableMessage = formatUnavailableModelMessage(
    trimmed,
    entry,
    availableIds,
    options,
  );
  if (options.fallbackMode === 'reject' || availableIds.length === 0) {
    throw new Error(unavailableMessage);
  }

  const fallback = availableIds[0]!;
  if (options.fallbackMode === 'silent') return { model: fallback };
  return {
    model: fallback,
    notice: `${unavailableMessage} Using "${fallback}" instead.`,
  };
}

export async function resolveCliRunnableModel(
  model: string,
  options: CliRunnableModelOptions,
): Promise<CliRunnableModelResolution> {
  const models = await getCliModelAccessList({ apiMode: options.apiMode });
  return resolveCliRunnableModelWithAccessList(models, model, options);
}

export async function resolveCliRunnableModelWithAccessList(
  models: readonly CliModelAccess[],
  model: string,
  options: CliRunnableModelOptions,
): Promise<CliRunnableModelResolution> {
  const trimmed = model.trim();
  const hiddenModelId =
    trimmed && !findModelAccess(models, trimmed)
      ? getCanonicalModelConfigId(trimmed)
      : undefined;
  let hiddenModel: CliModelAccess | undefined;
  if (hiddenModelId != null) {
    const hiddenModelOption = (
      await computeModelOptionsData([hiddenModelId])
    )[0];
    if (!hiddenModelOption) {
      throw new Error(
        `Model "${hiddenModelId}" is configured but has no option data.`,
      );
    }
    hiddenModel = toCliModelAccess(hiddenModelOption, options.apiMode);
    if (await includedAccessRequiresLogin(options)) {
      hiddenModel = toIncludedLoginRequiredAccess(hiddenModel);
    }
  }

  return resolveCliRunnableModelFromAccessList(
    withModelAccess(models, hiddenModel),
    trimmed,
    options,
  );
}
