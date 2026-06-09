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
import { getModelUnavailableReason } from '@model/computeModelOptions';

import { getHelperModelName } from './helperModelName';

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

export { getHelperModelName };

/** Resolve the configured helper model, create a non-streaming handler, and obtain a client. */
export async function createHelperModelKit(): Promise<HelperModelResult> {
  const modelName = getHelperModelName();

  const reason = await getModelUnavailableReason(modelName);
  if (reason) {
    return { kit: undefined, reason };
  }

  const handler = await createModelHandler(MODEL_CONFIGS[modelName]);
  handler.setOutputStreaming(false);
  handler.setProgressViewEnabled(false);

  const client = await handler.getClient();
  return { kit: { handler, client, modelName } };
}
