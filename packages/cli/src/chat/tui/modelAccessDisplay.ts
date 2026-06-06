import {
  noRunnableModelAccessReason,
  runnableCliModelAccessEntries,
  type CliModelAccess,
  type NoRunnableModelAccessReason,
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

const EMPTY_MODEL_LIST_SUMMARIES = {
  includedLoginRequired: 'Included relay models require sign-in.',
  included: 'No included relay models are runnable.',
  personal: 'No personal API-key models are runnable.',
} satisfies Record<NoRunnableModelAccessReason, string>;

const MODEL_ACCESS_LAUNCH_BLOCK_DESCRIPTIONS = {
  includedLoginRequired: 'Sign in with texra login for included relay models',
  included: 'No included relay models are runnable',
  personal: 'No personal API-key models are runnable',
} satisfies Record<NoRunnableModelAccessReason, string>;

const EMPTY_MODEL_LIST_RECOVERY = {
  includedLoginRequired: 'Run /login or switch with /api personal.',
  included: 'Switch with /api personal or try again later.',
  personal: 'Configure a provider key or switch with /api included.',
} satisfies Record<NoRunnableModelAccessReason, string>;

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
  return MODEL_ACCESS_LAUNCH_BLOCK_DESCRIPTIONS[
    noRunnableModelAccessReason(models, apiMode)
  ];
}

export function emptyModelListMessageForCliMode(
  models: readonly CliModelAccess[],
  apiMode: CliApiMode,
): string {
  const reason = noRunnableModelAccessReason(models, apiMode);
  return `${EMPTY_MODEL_LIST_SUMMARIES[reason]} ${EMPTY_MODEL_LIST_RECOVERY[reason]}`;
}
