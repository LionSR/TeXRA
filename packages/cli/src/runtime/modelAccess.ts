// Local imports - model surfaces
import { computeModelOptionsData } from '@model/computeModelOptions';
import type { ModelOptionData } from '@shared/schemas';

export interface CliModelAccess {
  readonly model: ModelOptionData;
  readonly available: boolean;
  readonly status: string;
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

export async function getCliModelAccess(
  modelValue: string,
): Promise<CliModelAccess | undefined> {
  const models = await computeModelOptionsData();
  const model = models.find((entry) => entry.value === modelValue);
  if (!model) return undefined;
  return toCliModelAccess(model);
}

export async function getCliModelAccessList(): Promise<CliModelAccess[]> {
  const models = await computeModelOptionsData();
  return models.map(toCliModelAccess);
}
