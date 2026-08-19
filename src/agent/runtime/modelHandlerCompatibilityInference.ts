import { ModelProvider } from 'llm-zoo';

import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import { isObject } from '@utils/core';
import {
  ModelHandlerCompatibilityKeySchema,
  type ModelHandlerCompatibilityKey,
} from './modelHandlerCompatibilityKey';

export function inferPersistedModelHandlerCompatibilityKey(
  model: string,
): ModelHandlerCompatibilityKey | undefined {
  const modelConfig = getRuntimeModelConfig(model);

  if (modelConfig?.provider === ModelProvider.GOOGLE) {
    throw new Error(
      'Persisted Google sessions without a model-handler identity cannot be resumed.',
    );
  }
  return undefined;
}

export function inferPersistedFlowModelHandlerCompatibilityKey(
  model: string,
  shared: unknown,
): ModelHandlerCompatibilityKey | undefined {
  if (!isObject(shared)) return undefined;
  const record = shared;

  const parsedKey = ModelHandlerCompatibilityKeySchema.nullish().safeParse(
    record.modelHandlerCompatibilityKey,
  );
  if (parsedKey.success && parsedKey.data) return parsedKey.data;

  // Inference reads model identity only; the persisted messages never fed the
  // decision, so they are not parsed here.
  return inferPersistedModelHandlerCompatibilityKey(model);
}
