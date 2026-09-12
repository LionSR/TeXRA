/**
 * Shared helper model resolution and handler creation.
 *
 * Used by session description generation, instruction polishing, and
 * AI-assisted agent creation — all lightweight, non-streaming one-shot
 * LLM calls that share the same configured "helper model" setting.
 */

import type { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import { auxiliaryRetry } from '@agent/modelHandlers/support/auxiliaryRetry';
import { createModelHandler } from '@agent/runtime/ModelFactory';
import {
  getModelUnavailableReason,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';

import { getHelperModelName } from './helperModelName';

/**
 * A ready-to-use helper model handler + client pair.
 */
export interface HelperModelKit {
  handler: ModelHandler;
  client: unknown;
}

type HelperModelResult =
  { kit: HelperModelKit } | { kit: undefined; reason: string };

/**
 * Resolve the configured helper model, create a non-streaming handler, and
 * obtain a client.
 *
 * `stores` are the process secret store and global state the caller already
 * holds (the `Secrets` / `AppState` services, or the stores a host root
 * threaded down), so helper resolution reads the same stores as the run that
 * asked for it.
 */
export async function createHelperModelKit(
  stores: ModelOptionStores,
): Promise<HelperModelResult> {
  const modelName = getHelperModelName(stores.globalState);

  const reason = await getModelUnavailableReason(modelName, stores);
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

  // Helper output is interpreted by its caller, not rewritten as document text.
  const handler = await createModelHandler(modelConfig, stores);
  handler.setOutputStreaming(false);
  handler.setProgressViewEnabled(false);

  const client = await handler.getClient();
  return { kit: { handler, client } };
}

/** A single non-streaming helper-model text completion. */
interface HelperModelCompletion {
  /** User message content. */
  userPrompt: string;
  /** Optional system prompt. */
  systemPrompt?: string;
  /** Cancel this auxiliary request and its bounded retries. */
  signal?: AbortSignal;
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
  { userPrompt, systemPrompt, signal }: HelperModelCompletion,
): Promise<string> {
  signal?.throwIfAborted();
  const messages = await kit.handler.initializeMessages(
    '',
    userPrompt,
    undefined,
    systemPrompt,
  );
  // Helper calls execute outside the run's ModelInvoker, so they need their own
  // bounded retry policy now that generation clients disable SDK retries.
  const result = await auxiliaryRetry(
    () =>
      kit.handler.createResponse({
        client: kit.client,
        messages,
        // Helper calls are deterministic one-shots, never sampled.
        temperature: 0,
        systemPrompt,
        signal,
      }),
    signal,
  );
  return kit.handler.extractResponse(result.response, '').text;
}
