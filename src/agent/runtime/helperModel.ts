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
 *
 * When the user has explicitly configured a helper model, we validate it
 * against the enabled model list and fall back to the first enabled model
 * if the configured one was removed. The built-in default is always
 * accepted — it doesn't need to appear in the user's visible model list
 * since it's used for internal auxiliary tasks, not user-facing generation.
 *
 * Used for merge operations, progress view defaults, and anywhere
 * only the model name (not a full handler) is needed.
 */
export function getHelperModelName(): string {
  const configuredModel = globalSM.get<string>(GlobalStateKey.HELPER_MODEL);
  const userExplicitlySet = isNonEmptyString(configuredModel);

  if (!userExplicitlySet) {
    return DEFAULT_HELPER_MODEL;
  }

  const resolved = configuredModel.trim();

  // Only validate user-chosen models against the enabled list.
  // The built-in default doesn't need to be in the list.
  if (resolved === DEFAULT_HELPER_MODEL) return resolved;

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
