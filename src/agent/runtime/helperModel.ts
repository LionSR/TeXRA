/**
 * Shared helper model resolution and handler creation.
 *
 * Used by session description generation, instruction polishing, and
 * AI-assisted agent creation — all lightweight, non-streaming one-shot
 * LLM calls that share the same configured "helper model" setting.
 */

// Third-party imports
import pRetry from 'p-retry';

// Local imports
import type { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import { createModelHandler } from '@agent/runtime/ModelFactory';
import { normalizeProviderError } from '@common/errors';
import { isUserAbort } from '@common/errors/sdkErrorUtils';
import { getModelUnavailableReason } from '@model/computeModelOptions';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';

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
  { kit: HelperModelKit } | { kit: undefined; reason: string };

/** Resolve the configured helper model, create a non-streaming handler, and obtain a client. */
export async function createHelperModelKit(): Promise<HelperModelResult> {
  const modelName = getHelperModelName();

  const reason = await getModelUnavailableReason(modelName);
  if (reason) {
    return { kit: undefined, reason };
  }

  const modelConfig = await resolveRuntimeModelConfig(modelName);
  if (!modelConfig) {
    return {
      kit: undefined,
      reason: `Model "${modelName}" is not recognized.`,
    };
  }

  const handler = await createModelHandler(modelConfig);
  handler.setOutputStreaming(false);
  handler.setProgressViewEnabled(false);

  const client = await handler.getClient();
  return { kit: { handler, client, modelName } };
}

/** A single non-streaming helper-model text completion. */
export interface HelperModelCompletion {
  /** User message content. */
  userPrompt: string;
  /** Optional system prompt. */
  systemPrompt?: string;
  /** Sampling temperature (defaults to 0 for deterministic helper calls). */
  temperature?: number;
}

/**
 * Run one non-streaming completion against a helper-model kit and return the
 * extracted response text.
 *
 * Encapsulates the `initializeMessages → createResponse → extractResponse`
 * handler protocol so callers (session descriptions, instruction polishing,
 * agent creation, LaTeX text connection) share one call path instead of each
 * reaching into the {@link ModelHandler} internals.
 */
export async function runHelperModelCompletion(
  kit: HelperModelKit,
  { userPrompt, systemPrompt, temperature = 0 }: HelperModelCompletion,
): Promise<string> {
  const messages = await kit.handler.initializeMessages(
    '',
    userPrompt,
    undefined,
    systemPrompt,
  );
  // Helper calls execute outside ModelInvocationNode, so they need their own
  // bounded retry policy now that generation clients disable SDK retries.
  const result = await pRetry(
    () =>
      kit.handler.createResponse({
        client: kit.client,
        messages,
        temperature,
        systemPrompt,
      }),
    {
      retries: 2,
      minTimeout: 500,
      factor: 2,
      randomize: true,
      shouldRetry: ({ error }) =>
        !isUserAbort(error) && normalizeProviderError(error).userRetryable,
    },
  );
  return kit.handler.extractResponse(result.response, '').text;
}
