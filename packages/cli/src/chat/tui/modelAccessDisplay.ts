import {
  formatCliNoRunnableModelsLaunchBlock,
  formatCliNoRunnableModelsMessage,
  noRunnableModelAccessReason,
  runnableCliModelAccessEntries,
  type CliModelAccess,
} from '@cli/runtime/modelAccess';
import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import type { ModelAvailabilityKind } from '@shared/schemas';

import type { SelectItem } from './ui/Select';

const RELAY_STATUS_BY_AVAILABILITY = {
  'included-access': 'relay: included',
  'not-included': 'relay: not included',
  'included-login-required': 'relay: login required',
  'relay-quota-exhausted': 'relay: quota exhausted',
  'provider-key': 'relay: unavailable; api key set',
  'openrouter-key': 'relay: unavailable; openrouter key set',
  'missing-key': 'relay: unavailable; missing api key',
} satisfies Record<ModelAvailabilityKind, string>;

export function formatModelStatusForCliMode(
  model: CliModelAccess,
  apiMode: CliApiMode,
): string {
  if (apiMode === 'personal') return `api: ${model.status}`;

  const availability = model.model.availability;
  if (availability == null) return `relay: ${model.status}`;
  return RELAY_STATUS_BY_AVAILABILITY[availability];
}

export function modelSelectItemsForCliMode(
  models: readonly CliModelAccess[],
  apiMode: CliApiMode,
  getModelSwitchDisabledReason?: (model: string) => string | undefined,
): ReadonlyArray<SelectItem<string>> {
  return runnableCliModelAccessEntries(models, apiMode).map((model) => {
    const disabledReason = getModelSwitchDisabledReason?.(model.model.value);
    const status = formatModelStatusForCliMode(model, apiMode);
    return {
      value: model.model.value,
      label: model.model.label || model.model.value,
      description: disabledReason ? `${status}; ${disabledReason}` : status,
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
): string {
  return formatCliNoRunnableModelsMessage(
    noRunnableModelAccessReason(models, apiMode),
    {
      includedModeAction: 'switch with /api included',
      loginAction: 'Run /login',
      personalModeAction: 'switch with /api personal',
    },
  );
}
