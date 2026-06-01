// Third-party imports
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports - model surfaces
import { computeModelOptionsData } from '@model/computeModelOptions';
import type { ModelOptionData } from '@shared/schemas';

import type { CliApiMode } from './apiAccessMode';
import { getCliAuthProvider } from './supabaseAuth';

export interface CliModelAccess {
  readonly model: ModelOptionData;
  readonly available: boolean;
  readonly status: string;
}

export interface CliRunnableModelResolution {
  readonly model: string;
  readonly notice?: string;
}

export interface CliRunnableModelOptions {
  readonly allowFallback: boolean;
  readonly apiMode?: CliApiMode;
  readonly noAvailableModelsHint?: string;
  readonly noAvailableModelsMessage?: string;
}

export interface CliModelAccessListOptions {
  readonly apiMode?: CliApiMode;
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

function toCliModelAccess(model: ModelOptionData): CliModelAccess {
  return {
    model,
    available: !model.disabled && !model.requiresKey,
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
  const access = models.map(toCliModelAccess);
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

function availableModelIds(models: readonly CliModelAccess[]): string[] {
  return models
    .filter((entry) => entry.available)
    .map((entry) => entry.model.value);
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
    'noAvailableModelsHint' | 'noAvailableModelsMessage'
  >,
): string {
  if (ids.length > 0) return `Available models: ${ids.join(', ')}.`;
  if (options.noAvailableModelsMessage) {
    return `No models are currently available. ${options.noAvailableModelsMessage}`;
  }
  const modeHint =
    options.noAvailableModelsHint ??
    'Retry with `--api-mode included` to try included relay access';
  return `No models are currently available. ${modeHint}, run \`texra login\`, or configure a provider API key.`;
}

function formatUnavailableModelMessage(
  model: string,
  entry: CliModelAccess | undefined,
  availableIds: readonly string[],
  options: Pick<
    CliRunnableModelOptions,
    'noAvailableModelsHint' | 'noAvailableModelsMessage'
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
  const entry = findModelAccess(models, trimmed);
  if (entry?.available) return { model: entry.model.value };

  const availableIds = availableModelIds(models);
  const unavailableMessage = formatUnavailableModelMessage(
    trimmed,
    entry,
    availableIds,
    options,
  );
  if (!options.allowFallback || availableIds.length === 0) {
    throw new Error(unavailableMessage);
  }

  const fallback = availableIds[0]!;
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
    hiddenModel = toCliModelAccess(hiddenModelOption);
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
