/**
 * Shared helper model resolution and handler creation.
 *
 * Used by session description generation, instruction polishing, and
 * AI-assisted agent creation — all lightweight, non-streaming one-shot
 * LLM calls that share the same configured "helper model" setting.
 */

import { MODEL_CONFIGS } from 'llm-zoo';

import type { ModelHandler } from '@agent/modelHandlers';
import { createModelHandler } from '@agent/runtime/ModelFactory';
import { GlobalStateKey, globalSM } from '@common/state';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { isNonEmptyString } from '@utils/core';

/**
 * A ready-to-use helper model handler + client pair.
 */
export interface HelperModelKit {
  handler: ModelHandler;
  client: unknown;
  modelName: string;
}

/**
 * Resolve the configured helper model name from global state.
 * Falls back to the first enabled model when the configured (or default)
 * helper model is not in the user's visible model list.
 *
 * Used for merge operations, progress view defaults, and anywhere
 * only the model name (not a full handler) is needed.
 */
export function getHelperModelName(): string {
  const configuredModel = globalSM.get<string>(
    GlobalStateKey.HELPER_MODEL,
    DEFAULT_HELPER_MODEL,
  );
  const resolved = isNonEmptyString(configuredModel)
    ? configuredModel.trim()
    : DEFAULT_HELPER_MODEL;

  // Ensure the resolved model is actually in the user's enabled list.
  const enabledModels = globalSM.get<string[]>(
    GlobalStateKey.ENABLED_MODELS,
    [],
  );
  if (enabledModels.length === 0) return resolved;
  if (enabledModels.includes(resolved)) return resolved;
  return enabledModels[0];
}

/**
 * Resolve the configured helper model, create a non-streaming handler,
 * and obtain a client.
 *
 * Returns `undefined` when the configured model name is not found in
 * MODEL_CONFIGS (caller decides how to surface the error).
 * Throws if the model is valid but handler/client creation fails.
 */
export async function createHelperModelKit(): Promise<
  HelperModelKit | undefined
> {
  const modelName = getHelperModelName();

  const modelConfig = MODEL_CONFIGS[modelName];
  if (!modelConfig) {
    return undefined;
  }

  const handler = createModelHandler(modelConfig);
  handler.setOutputStreaming(false);
  handler.setProgressViewEnabled(false);

  const client = await handler.getClient();
  return { handler, client, modelName };
}
