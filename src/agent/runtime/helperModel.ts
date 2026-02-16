/**
 * Shared helper model resolution and handler creation.
 *
 * Used by session description generation, instruction polishing, and
 * AI-assisted agent creation — all lightweight, non-streaming one-shot
 * LLM calls that share the same configured "helper model" setting.
 */

import { MODEL_CONFIGS } from 'llm-zoo';

import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import type { ModelHandler } from '@agent/modelHandlers';
import { createModelHandler } from '@agent/runtime/ModelFactory';
import { GlobalStateKey, globalSM } from '@common/state';
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
  const configuredModel = globalSM.get<string>(
    GlobalStateKey.HELPER_MODEL,
    DEFAULT_HELPER_MODEL,
  );
  const modelName = isNonEmptyString(configuredModel)
    ? configuredModel.trim()
    : DEFAULT_HELPER_MODEL;

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
