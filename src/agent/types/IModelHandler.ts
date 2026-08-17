// Local imports - agent components
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
import type { ToolFileAttachment, ToolResult } from '@shared/schemas';
import type { ProviderMessage } from './ProviderMessage';

/**
 * Common port implemented by all model handlers.
 *
 * Derived from {@link ModelHandler} via `Pick` so the port surface can never
 * drift from the base class: adding, renaming, or retyping a member there is
 * automatically reflected here, and a base-class signature change breaks
 * exactly one place (the class) instead of two. Only members consumers
 * actually call through this port are picked. Omitted members are reached
 * through the concrete class instead: this includes internal-only helpers
 * such as `computePrice` and `supportsReasoningLevelOverride`, plus
 * `extractResponse`, which `helperModel` calls on its concrete handler.
 *
 * `createBatchedToolUseFollowUpMessages` is the one thing this port expresses
 * that the class doesn't: it's an interface-only optional extension that
 * `ToolUseDispatchNode` feature-detects for providers requiring batched
 * parallel tool-result messages (e.g. Google, DeepSeek, Kimi, MiniMax).
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
  | 'getStreamingConfig'
  | 'getWireRouteKey'
  | 'getModelRetryRouteKey'
  | 'setOutputStreaming'
  | 'isBackgroundModeActive'
  | 'supportsManualCompaction'
  | 'supportsForcedToolChoice'
  | 'requiresPerCallSystemPrompt'
  | 'requestCompaction'
  | 'clearCompactionRequest'
  | 'getEffectiveContextWindow'
  | 'requiresBatchedParallelToolResults'
  | 'setLogger'
  | 'setAgentCategory'
  | 'getClient'
  | 'refreshClient'
  | 'createResponse'
  | 'initializeMessages'
  | 'createRoundMessages'
  | 'extractNormalizedResponse'
  | 'addContinueMessage'
  | 'initializeOutputAndPrefill'
  | 'getLastCredentialUsageRoute'
  | 'getCredentialRouteForClient'
  | 'updateMessageContent'
  | 'shouldContinue'
  | 'checkStopConditions'
  | 'processThinkingBlock'
  | 'extractToolUse'
  | 'extractServerToolData'
  | 'createToolUseFollowUpMessages'
  | 'createUserFollowUpMessages'
  | 'createAssistantMessageFromResponse'
  | 'isEndTurnStop'
  | 'extractAssistantContent'
  | 'extractAssistantText'
  | 'prependTextToUserMessage'
  | 'addMediaToUserMessage'
  | 'consumeInsertedAttachmentKinds'
  | 'dispose'
> & {
  /**
   * Create provider-specific messages for MULTIPLE parallel tool calls.
   *
   * This is optional and primarily used by Google handlers to properly structure
   * parallel function calls with thought signatures (required for Gemini 3 models).
   *
   * When implemented:
   * - All function calls go in ONE model message (first call has thoughtSignature)
   * - All function responses go in ONE user message
   *
   * @param entries - One entry per tool call, in original model-response order.
   *   Each entry bundles the call with its own result and attachments, so
   *   alignment is structural rather than three positionally-zipped arrays.
   * @param workspaceState - Workspace state for reasoning blocks, if any
   * @param text - Text to include before the function calls, if any
   * @param client - Client bound to the current run and credential route.
   *   Required: the caller already holds the run's client, so a handler that
   *   uploads tool-result attachments uses that one rather than resolving a
   *   second credential route of its own.
   */
  createBatchedToolUseFollowUpMessages?(
    entries: Array<{
      call: T;
      result: ToolResult;
      attachments: ToolFileAttachment[];
    }>,
    workspaceState: AgentWorkspaceState | undefined,
    text: string | undefined,
    client: C,
  ): Promise<M[]>;
};
