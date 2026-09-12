// Local imports - agent components
import type { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
import type { ProviderMessage } from './ProviderMessage';

/**
 * Common port implemented by all model handlers.
 *
 * Derived from {@link ModelHandler} via `Pick` alone — the port adds nothing
 * of its own, so a member's SIGNATURE can never drift from the base class:
 * retyping one there is reflected here automatically and renaming one breaks
 * this `Pick`, so a signature only ever needs editing in one place (the class)
 * rather than two.
 *
 * The member SET is curated, not automatic: adding a member to the base class
 * does not surface it here, by design — only members consumers actually call
 * through this port are picked. The run loop never calls a handler (it calls
 * the llm `Model` through `ModelInvoker`); the port serves the helper paths
 * (`helperModel`, `agentCreatorFlow`, `userVars`), `ModelCell`, and the
 * manual-compaction command. Omitted members are reached through the
 * concrete class instead, including internal-only helpers such as
 * `supportsReasoningLevelOverride` and `extractResponse`, which `helperModel`
 * calls on its concrete handler.
 *
 * @template M - Message type specific to the provider (e.g., MessageParam for Anthropic,
 *               ChatCompletionMessageParam for OpenAI). Must extend ProviderMessage.
 * @template U - Usage/statistics type returned by the provider's API response
 *               (e.g., Usage for Anthropic, CompletionUsage for OpenAI)
 * @template T - Tool call type (defaults to the full SdkToolCall union)
 * @template C - Provider-specific client type
 * @template Resp - Provider-specific response object type
 */
export type IModelHandler<
  M extends ProviderMessage = ProviderMessage,
  U = unknown,
  T extends SdkToolCall = SdkToolCall,
  C = unknown,
  Resp = unknown,
> = Pick<
  ModelHandler<M, U, T, C, Resp>,
  | 'config'
  | 'capabilities'
  | 'setOutputStreaming'
  | 'supportsManualCompaction'
  | 'setLogger'
  | 'setAgentCategory'
  | 'getClient'
  | 'refreshClient'
  | 'createResponse'
  | 'initializeMessages'
  | 'getCredentialRouteForClient'
  | 'dispose'
>;
