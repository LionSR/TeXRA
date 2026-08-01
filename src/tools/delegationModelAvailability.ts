import type { ToolDefinition } from '@model/ToolDefinition';
import { decideRunModel } from '@model/runModelDecision';
import { isModelOptionAvailable, type ModelOptionData } from '@shared/schemas';
import { replaceDelegationDescriptionBlock } from '@tools/delegationDescriptionBlock';
import { unique } from '@utils/core';

const AVAILABLE_MODELS_LINE = /^Available models:.*$/m;

const NO_DELEGATION_MODELS_MESSAGE =
  'No models are currently available for delegation in the active API mode. Switch API mode or configure a provider API key before delegating.';

export function availableModelNamesFromOptions(
  models: readonly ModelOptionData[],
): string[] {
  return models.filter(isModelOptionAvailable).map((model) => model.value);
}

function formatAvailableModelsLine(
  modelNames: readonly string[] | null,
): string {
  if (modelNames === null) {
    return 'Available models: unavailable to load; omit model unless the user explicitly requested one.';
  }
  if (modelNames.length === 0) {
    return 'Available models: none currently available. Ask the user to switch API mode or configure an API key before delegating.';
  }
  return `Available models: ${modelNames.join(', ')}`;
}

function normalizeModelName(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  return trimmed ? trimmed : null;
}

export function selectDelegationModelFromAvailableNames(input: {
  readonly requestedModel?: string | null;
  readonly parentModel?: string | null;
  readonly availableModels: readonly string[];
}): string {
  const availableModels = unique(
    input.availableModels.map((model) => model.trim()).filter(Boolean),
  );
  if (availableModels.length === 0) {
    throw new Error(NO_DELEGATION_MODELS_MESSAGE);
  }

  const decision = decideRunModel(
    [
      { model: input.requestedModel, reason: 'explicit-override' },
      {
        model: input.parentModel,
        reason: 'parent-run',
        fallbackMode: 'silent',
      },
      { model: availableModels[0], reason: 'access-list-default' },
    ],
    (model) => availableModels.includes(model),
  );
  if (!decision) {
    throw new Error(NO_DELEGATION_MODELS_MESSAGE);
  }
  if (decision.unavailable) {
    const requestedModel = normalizeModelName(input.requestedModel);
    throw new Error(
      `Model "${requestedModel}" is not currently available for delegation in the active API mode. Available models: ${availableModels.join(', ')}.`,
    );
  }
  return decision.model;
}

export function withDelegationModelAvailability(
  tool: ToolDefinition,
  modelNames: readonly string[] | null,
): ToolDefinition {
  return replaceDelegationDescriptionBlock(
    tool,
    AVAILABLE_MODELS_LINE,
    () => formatAvailableModelsLine(modelNames),
    { appendIfMissing: true },
  );
}
