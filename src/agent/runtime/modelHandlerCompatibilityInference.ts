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

function isGoogleGenAIContentMessage(message: ProviderMessage): boolean {
  if (!isObject(message)) return false;
  const record = message as Record<string, unknown>;
  if ('type' in record) return false;
  const role = record.role;
  if (role !== 'user' && role !== 'model' && role !== 'system') {
    return false;
  }
  return Array.isArray(record.parts);
}

function isGoogleInteractionsStepMessage(message: ProviderMessage): boolean {
  if (!isObject(message)) return false;
  const type = (message as Record<string, unknown>).type;
  return (
    type === 'user_input' ||
    type === 'model_output' ||
    type === 'thought' ||
    type === 'function_call' ||
    type === 'function_result'
  );
}

function isOpenRouterChatMessage(message: ProviderMessage): boolean {
  if (!isObject(message)) return false;
  const record = message as Record<string, unknown>;
  if ('type' in record || 'parts' in record) return false;
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
  const stateSlices = shared.stateSlices;
  if (!isObject(stateSlices)) return undefined;
  const userChannels = stateSlices.userChannels;
  if (!isObject(userChannels)) return undefined;
  const transient = userChannels.transient;
  const input = userChannels.input;
  return (
    (isObject(transient) ? stringValue(transient.MODEL) : undefined) ??
    (isObject(input) ? stringValue(input.MODEL) : undefined)
  );
}

function unwrapSharedState(shared: unknown): Record<string, unknown> | null {
  if (!isObject(shared)) return null;
  return isObject(shared.state)
    ? (shared.state as Record<string, unknown>)
    : shared;
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

  const messages =
    normalizeProviderMessages(record.messages) ??
    normalizeProviderMessages(record.conversation) ??
    normalizeProviderMessages(record);
  if (!messages) return undefined;

  return inferPersistedModelHandlerCompatibilityKey(
    currentModelFromRawSharedState(record) ?? model,
    messages,
  );
}
