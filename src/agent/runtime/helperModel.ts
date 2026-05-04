/**
 * Shared helper model resolution and handler creation.
 *
 * Used by session description generation, instruction polishing, and
 * AI-assisted agent creation — all lightweight, non-streaming one-shot
 * LLM calls that share the same configured "helper model" setting.
 */

import { MODEL_CONFIGS } from 'llm-zoo';

import type { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import { createModelHandler } from '@agent/runtime/ModelFactory';
import { getGlobalState } from '@agent/core/stateStore';
import { GlobalStateKey } from '@common/state';
import { getModelUnavailableReason } from '@model/computeModelOptions';
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

export type HelperModelResult =
  | { kit: HelperModelKit }
  | { kit: undefined; reason: string };

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
  const configuredModel = getGlobalState().get<string>(
    GlobalStateKey.HELPER_MODEL,
  );
  if (!isNonEmptyString(configuredModel)) {
    return DEFAULT_HELPER_MODEL;
  }

  const resolved = configuredModel.trim();

  // Only validate user-chosen models against the enabled list.
  // The built-in default doesn't need to be in the list.
  if (resolved === DEFAULT_HELPER_MODEL) return resolved;

  const enabledModels = getGlobalState().get<string[]>(
    GlobalStateKey.ENABLED_MODELS,
    [],
  );
  if (enabledModels.length === 0 || enabledModels.includes(resolved)) {
    return resolved;
  }
  return enabledModels[0];
}

/** Resolve the configured helper model, create a non-streaming handler, and obtain a client. */
export async function createHelperModelKit(): Promise<HelperModelResult> {
  const modelName = getHelperModelName();

  const reason = await getModelUnavailableReason(modelName);
  if (reason) {
    return { kit: undefined, reason };
  }

  const handler = createModelHandler(MODEL_CONFIGS[modelName]);
  handler.setOutputStreaming(false);
  handler.setProgressViewEnabled(false);

  const client = await handler.getClient();
  return { kit: { handler, client, modelName } };
}
