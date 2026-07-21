import { ModelProvider } from 'llm-zoo';

import type { AgentTrace } from '@agent/trace';
import {
  normalizeProviderMessages,
  type ProviderMessage,
} from '@agent/types/ProviderMessage';
import {
  getRuntimeModelConfig,
  isRuntimeModel,
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

function isGoogleGenAIContentMessage(message: ProviderMessage): boolean {
  const record = asRecord(message);
  if (!record || 'type' in record) return false;
  const role = record.role;
  if (role !== 'user' && role !== 'model' && role !== 'system') {
    return false;
  }
  return Array.isArray(record.parts);
}

function isGoogleInteractionsStepMessage(message: ProviderMessage): boolean {
  const type = asRecord(message)?.type;
  return (
    type === 'user_input' ||
    type === 'model_output' ||
    type === 'thought' ||
    type === 'function_call' ||
    type === 'function_result'
  );
}

function isOpenRouterChatMessage(message: ProviderMessage): boolean {
  const record = asRecord(message);
  if (!record || 'type' in record || 'parts' in record) return false;
  const role = record.role;
  return (
    (role === 'system' ||
      role === 'user' ||
      role === 'assistant' ||
      role === 'tool') &&
    'content' in record
  );
}

export function inferPersistedModelHandlerCompatibilityKey(
  model: string,
  messages: readonly ProviderMessage[],
): ModelHandlerCompatibilityKey | undefined {
  const modelConfig = getRuntimeModelConfig(model);
  if (isRuntimeModel(model)) return 'ModelHandlerVscodeLm';

  // Copilot had no direct handler before ModelHandlerVscodeLm. Its only
  // runnable legacy route was OpenRouter, so a keyless persisted transcript
  // necessarily uses the OpenRouter message format. New Copilot sessions
  // persist their explicit compatibility key and do not enter this inference.
  if (modelConfig?.provider === ModelProvider.COPILOT) {
    return 'ModelHandlerOpenRouterNative';
  }
  if (modelConfig?.provider !== ModelProvider.GOOGLE) return undefined;
  if (messages.some(isGoogleGenAIContentMessage)) {
    return 'ModelHandlerGoogleGenAI';
  }
  if (messages.some(isGoogleInteractionsStepMessage)) {
    return 'ModelHandlerGoogleInteractions';
  }
  return messages.some(isOpenRouterChatMessage)
    ? 'ModelHandlerOpenRouterNative'
    : undefined;
}

export function inferAndLogPersistedModelHandlerCompatibilityKey(
  model: string,
  messages: readonly ProviderMessage[],
  logger: Pick<AgentTrace, 'info'>,
): ModelHandlerCompatibilityKey | undefined {
  const compatibilityKey = inferPersistedModelHandlerCompatibilityKey(
    model,
    messages,
  );
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
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function currentModelFromRawSharedState(
  shared: Record<string, unknown>,
): string | undefined {
  const userChannels = asRecord(asRecord(shared.stateSlices)?.userChannels);
  if (!userChannels) return undefined;
  const transient = asRecord(userChannels.transient);
  const input = asRecord(userChannels.input);
  return (
    (transient ? stringValue(transient.MODEL) : undefined) ??
    (input ? stringValue(input.MODEL) : undefined)
  );
}

function unwrapSharedState(shared: unknown): Record<string, unknown> | null {
  const record = asRecord(shared);
  if (!record) return null;
  return asRecord(record.state) ?? record;
}

export function inferPersistedFlowModelHandlerCompatibilityKey(
  model: string,
  shared: unknown,
): ModelHandlerCompatibilityKey | undefined {
  const record = unwrapSharedState(shared);
  if (!record) return undefined;

  const parsedKey = ModelHandlerCompatibilityKeySchema.nullish().safeParse(
    record.modelHandlerCompatibilityKey,
  );
  if (parsedKey.success && parsedKey.data) return parsedKey.data;

  // The union in `normalizeProviderMessages` already tries `record` as a bare
  // messages array, then `record.messages`, then `record.conversation` — one
  // call covers all three legacy shapes.
  const messages = normalizeProviderMessages(record);
  if (!messages) return undefined;

  return inferPersistedModelHandlerCompatibilityKey(
    currentModelFromRawSharedState(record) ?? model,
    messages,
  );
}
