import { ModelProvider } from 'llm-zoo';

import type { AgentTrace } from '@agent/trace';
import {
  COPILOT_MODEL_PREFIX,
  getRuntimeModelConfig,
} from '@model/runtimeModelRegistry';
import { isObject } from '@utils/core';
import {
  ModelHandlerCompatibilityKeySchema,
  type ModelHandlerCompatibilityKey,
} from './modelHandlerCompatibilityKey';

/**
 * Narrow an arbitrary value to a plain-object record, or `undefined` if it
 * isn't one. `isObject` already narrows its own parameter, but narrowing
 * `message: ProviderMessage` (a union of provider SDK types with no common
 * shape) through it still leaves per-property access needing a cast — this
 * wraps that once for every shape-sniffing call site below instead of each
 * repeating `isObject(x) ? (x as Record<string, unknown>) : ...` by hand.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

export function inferPersistedModelHandlerCompatibilityKey(
  model: string,
): ModelHandlerCompatibilityKey | undefined {
  // Compatibility reader for transcripts persisted while Copilot models were
  // synthetic `copilot:<baseModel>` ids (#9635, introduced 2026-08-03; retire
  // three months after ship, target 2026-11-03). Those sessions ran through
  // ModelHandlerVscodeLm by construction; new sessions persist their explicit
  // compatibility key and never reach this inference.
  if (model.startsWith(COPILOT_MODEL_PREFIX)) return 'ModelHandlerVscodeLm';

  const modelConfig = getRuntimeModelConfig(model);

  // Copilot had no direct handler before ModelHandlerVscodeLm. Its only
  // runnable legacy route was OpenRouter, so a keyless persisted transcript
  // necessarily uses the OpenRouter message format. New Copilot sessions
  // persist their explicit compatibility key and do not enter this inference.
  if (modelConfig?.provider === ModelProvider.COPILOT) {
    return 'ModelHandlerOpenRouterNative';
  }
  if (modelConfig?.provider === ModelProvider.GOOGLE) {
    throw new Error(
      'Persisted Google sessions without a model-handler identity cannot be resumed.',
    );
  }
  return undefined;
}

export function inferAndLogPersistedModelHandlerCompatibilityKey(
  model: string,
  logger: Pick<AgentTrace, 'info'>,
): ModelHandlerCompatibilityKey | undefined {
  const compatibilityKey = inferPersistedModelHandlerCompatibilityKey(model);
  if (compatibilityKey) {
    logger.info(
      'Inferred model-handler compatibility for keyless persisted run',
      {
        data: { model, compatibilityKey },
      },
    );
  }
  return compatibilityKey;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}

function currentModelFromRawSharedState(
  shared: Record<string, unknown>,
): string | undefined {
  const modelId = stringValue(shared.modelId);
  if (modelId) return modelId;
  // Records written before `modelId` carry the model only in `MODEL`, and this
  // reader runs on raw bytes that never passed the migration boundary.
  const userChannels = asRecord(asRecord(shared.stateSlices)?.userChannels);
  if (!userChannels) return undefined;
  return (
    stringValue(asRecord(userChannels.transient)?.MODEL) ??
    stringValue(asRecord(userChannels.input)?.MODEL)
  );
}

export function inferPersistedFlowModelHandlerCompatibilityKey(
  model: string,
  shared: unknown,
): ModelHandlerCompatibilityKey | undefined {
  const record = asRecord(shared);
  if (!record) return undefined;

  const parsedKey = ModelHandlerCompatibilityKeySchema.nullish().safeParse(
    record.modelHandlerCompatibilityKey,
  );
  if (parsedKey.success && parsedKey.data) return parsedKey.data;

  // Inference reads model identity only; the persisted messages never fed the
  // decision, so they are not parsed here.
  return inferPersistedModelHandlerCompatibilityKey(
    currentModelFromRawSharedState(record) ?? model,
  );
}
