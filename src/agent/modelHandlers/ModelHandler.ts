// Third-party imports
import { FinishReason } from '@google/genai';

// Shared schemas
import { MESSAGE_TYPES } from '@shared/schemas';

// Local imports - auth
import { SupabaseClient } from '@auth/SupabaseClient';
import { MAX_TIER } from '@auth/config';
import { getServerSideKeyService } from '@auth/serverKeys';

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory, type AgentSetting } from '@agent/core/AgentDataclass';
import { ConversationRoundState, AgentRunState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { MediaEntry } from '@agent/utils/mediaTypes';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';

// Local imports - frontend
import { SecretManager, ApiProvider } from '@frontend/secretManager';

// Local imports - logger
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - model
import {
  ModelConfig,
  ModelProvider,
  ModelCapabilities,
  ReasoningEffort,
} from '@model/ModelConfig';

// Local imports - tools
import type { ToolFileAttachment } from '@tools/result';

// Local imports - utils
import { K_SLICE } from '@utils/config';
import {
  getProviderStreaming,
  getGlobalStreaming,
} from '@utils/config/constants';
import type { FileLocation } from '@utils/files';
import { MediaAttachmentProcessor } from './support/MediaAttachmentProcessor';
import {
  resolveBaseUrl,
  shouldUseOpenRouter,
} from './support/ProxyConfigResolver';
import {
  ANTHROPIC_STOP,
  OPENAI_CHAT_FINISH,
  MCP_STOP,
} from './types/StopReasonTypes';
import {
  computeReducedMaxTokens,
  TOKEN_SAFETY_BUFFER,
  TOOL_USE_MAX_OUTPUT_FACTOR,
} from './contextManagementConstants';

// Type imports
import type { ProviderStopReason } from './types/StopReasonTypes';
import type { ProviderMessage } from './types/ProviderMessage';
import type { ToolResultPayload } from './utils/toolAttachmentUtils';
import type {
  IModelHandler,
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  SdkToolCall,
  StopConditionsResult,
  TokenCountOptions,
  TokenValidationResult,
} from './types/IModelHandler';
import type {
  ServerToolExtractionResult,
  WebSearchResult,
} from './types/ServerToolTypes';

// Default continuation limits
const DEFAULT_CONTINUE_LIMIT = 10;

// Default token limits
const DEFAULT_INPUT_TOKEN_LIMIT = 1500000;
const DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR = 2.5;

/**
 * Abstract base class for model-specific handlers that manage API interactions, message processing, and response handling.
 * @template M Provider-specific message type
 * @template U Provider-specific usage type
 * @template R Provider-specific response usage type
 * @template T Provider-specific tool call type
 * @template C Provider-specific client type
 */
export abstract class ModelHandler<
  M extends ProviderMessage = ProviderMessage,
  U = unknown,
  R = unknown,
  T extends SdkToolCall = SdkToolCall,
  C = unknown,
  Resp = unknown,
> implements IModelHandler<M, U, R, T, C, Resp> {
  public config: ModelConfig;
  public capabilities: ModelCapabilities;
  public continueLimit: number;
  public inputTokenLimit: number;
  public maxOutputTokensFactor: number;
  protected logger: AgentLogger;
  protected outputStreaming = false;
  protected backgroundModeSupported = false;
  protected progressViewEnabled = true;
  protected agentCategory?: AgentCategory;
  protected mediaProcessor: MediaAttachmentProcessor;

  /**
   * Whether the handler supports processing attachments in tool results.
   * Override in handlers that don't support attachments (e.g., DeepSeek).
   */
  get canProcessToolResultAttachments(): boolean {
    return true;
  }

  /**
   * Whether the handler can upload files to the provider's API for tool results.
   * Override in handlers that support provider-specific file upload APIs
   * (e.g., Anthropic Files API, OpenAI Files API).
   */
  protected get supportsToolResultFileUpload(): boolean {
    return false;
  }

  constructor(config: ModelConfig) {
    this.config = { ...config };
    this.capabilities = structuredClone(config.capabilities);
    this.continueLimit = DEFAULT_CONTINUE_LIMIT;
    this.inputTokenLimit = DEFAULT_INPUT_TOKEN_LIMIT;
    this.maxOutputTokensFactor = DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR;
    // Initialize with default channel, will be overwritten by agent
    this.logger = new AgentLogger('Agent');
    this.mediaProcessor = new MediaAttachmentProcessor(this.logger, {
      getCapabilities: () => this.capabilities,
      isOpenAIProvider: () => this.isOpenai,
    });
  }

  /**
   * Updates the logger instance.
   */
  public setLogger(logger: AgentLogger): void {
    this.logger = logger;
    this.mediaProcessor.setLogger(logger);
  }

  /**
   * Records the active agent category so provider handlers can adjust behaviour per session.
   */
  public setAgentCategory(agentCategory?: AgentCategory | null): void {
    this.agentCategory = agentCategory ?? undefined;
  }

  /**
   * Returns the agent category that is currently driving the handler, if any.
   */
  public getAgentCategory(): AgentCategory | undefined {
    return this.agentCategory;
  }

  /**
   * Returns true if the handler is operating in tool-use mode.
   * Used to enable context management and other tool-use-specific behaviors.
   */
  protected isToolUseMode(): boolean {
    return this.agentCategory === AgentCategory.ToolUse;
  }

  /**
   * Returns true if the handler is operating in workflow mode.
   * Used for workflow-specific behaviors like background mode eligibility.
   */
  protected isWorkflowMode(): boolean {
    return this.agentCategory === AgentCategory.Workflow;
  }

  /**
   * Returns the effective max output tokens for the current mode.
   * Tool-use agents use a reduced value to leave headroom for context growth.
   */
  protected getEffectiveMaxOutputTokens(): number {
    const base = this.config.maxOutputTokens;
    if (!this.isToolUseMode()) {
      return base;
    }
    return Math.floor(base * TOOL_USE_MAX_OUTPUT_FACTOR);
  }

  /**
   * Enables or disables streaming of model output text.
   */
  public setOutputStreaming(enabled: boolean): void {
    this.outputStreaming = enabled;
  }

  /**
   * Indicates whether model output streaming is enabled.
   */
  public isOutputStreamingEnabled(): boolean {
    return this.outputStreaming;
  }

  /**
   * Indicates whether background mode is active for this handler.
   * Background mode runs requests asynchronously and polls for completion.
   * Override in handlers that support background execution.
   */
  public isBackgroundModeActive(): boolean {
    return false;
  }

  /**
   * Enables or disables Progress view updates.
   */
  public setProgressViewEnabled(enabled: boolean): void {
    this.progressViewEnabled = enabled;
  }

  /**
   * Convenience wrapper for thinking streams.
   */
  protected createThinkingStream() {
    return this.logger.createStream(MESSAGE_TYPES.THINKING, {
      progressViewEnabled: this.progressViewEnabled,
    });
  }

  /**
   * Convenience wrapper for output streams.
   */
  protected createOutputStream() {
    return this.logger.createStream(MESSAGE_TYPES.MODEL_RESPONSE, {
      progressViewEnabled: this.progressViewEnabled,
    });
  }

  /**
   * Emit web search result to progress view during streaming.
   * This allows search results to appear in correct order based on when
   * they occurred in the response, rather than being logged after streaming.
   */
  protected emitWebSearchResult(result: WebSearchResult): void {
    if (!this.progressViewEnabled) {
      return;
    }
    this.logger.logWebSearch(result);
  }

  /**
   * Check if server-side keys should be used for this model.
   *
   * Centralizes the decision to avoid duplication between getApiKey() and getBaseUrl().
   * Both methods call this to ensure consistent routing decisions.
   *
   * Returns true only if:
   * 1. Model is not openRouterOnly (those always use OpenRouter)
   * 2. shouldUseServerSideKeysSync confirms access:
   *    - Setting enabled
   *    - Provider supported
   *    - Tier-based model access (Ultra=all, Max/free=specific models)
   *
   * MODEL VALIDATION STRATEGY:
   * - Client validates SHORT NAMES (this.config.name) against tier config
   * - Server validates API NAMES (from request body) against API patterns
   * - Both are defined in RELAY_MODELS, ensuring UI filtering matches API validation
   */
  protected shouldUseServerSideKeys(): boolean {
    // Skip openRouterOnly models - these should always route through OpenRouter
    // since their model IDs don't exist on provider APIs.
    if (this.config.openRouterOnly) {
      return false;
    }
    // Pass short name (this.config.name) for client-side tier validation.
    // The server will separately validate the actual API model name from the request.
    return getServerSideKeyService().shouldUseServerSideKeysSync(
      this.config.provider,
      this.config.name,
    );
  }

  /**
   * Retrieves API key from environment variables based on provider and OpenRouter configuration.
   * When server-side keys are enabled (experimental), returns the user's JWT token instead,
   * which the relay Edge Function will use for authentication.
   *
   * When "Use Included Access" is enabled, only server-side keys are used - no fallback
   * to personal API keys. This ensures runtime behavior matches dropdown availability.
   *
   * @throws Error if required API key is missing from environment
   */
  public async getApiKey(): Promise<string> {
    const serverSideKeyService = getServerSideKeyService();
    const useIncludedAccess = serverSideKeyService.getUseIncludedModelAccess();

    // Prime caches before using sync methods. This ensures that after reload/continue,
    // the tier config and access status are fetched before shouldUseServerSideKeys() is called.
    // Without this, sync methods return false due to empty caches, causing incorrect tier errors.
    if (useIncludedAccess) {
      await serverSideKeyService.canUseServerSideKeys();
    }

    // Use centralized check to ensure consistency with getBaseUrl()
    if (this.shouldUseServerSideKeys()) {
      const accessToken = await SupabaseClient.getAccessToken();
      if (accessToken) {
        this.logger.debug(
          `Using server-side API keys via relay for ${this.config.provider}`,
        );
        return accessToken;
      }
      // No access token available - shouldUseServerSideKeys() returned true, meaning isEnabled()
      // returned true. Don't fall back to personal keys - throw an actionable error.
      throw new Error(
        'Unable to authenticate with server. Please sign out and sign back in, or switch to "Use My Own Keys" mode.',
      );
    }

    // openRouterOnly models can NEVER use server-side relay - they always need OpenRouter key.
    // Allow these even in "Use Included Access" mode since included access is never possible.
    if (this.config.openRouterOnly) {
      try {
        return await SecretManager.getApiKey('openRouter');
      } catch (err) {
        throw new Error(
          `Model "${this.config.name}" requires an OpenRouter API key. Please set it using the "Set API Key" command.`,
        );
      }
    }

    if (useIncludedAccess) {
      // User selected "Use Included Access" but model is not available for their tier
      // Don't fall back to personal API keys - throw an error to match dropdown behavior
      this.logger.debug(
        `Model "${this.config.name}" not available for tier, useIncludedAccess=true`,
      );
      throw new Error(
        `Model "${this.config.name}" is not available with your current subscription tier. ` +
          `Switch to "Use My Own Keys" via the TeXRA Profile panel, or select a model included in your tier.`,
      );
    }

    if (shouldUseOpenRouter(this.config)) {
      try {
        return await SecretManager.getApiKey('openRouter');
      } catch (err) {
        throw new Error(
          'Missing API key for OpenRouter. Please set it using the "Set API Key" command.',
        );
      }
    }

    const provider = this.config.provider.toLowerCase() as ApiProvider;
    try {
      return await SecretManager.getApiKey(provider);
    } catch (err) {
      throw new Error(
        `Missing API key for ${this.config.provider}. Please set it using the "Set API Key" command.`,
      );
    }
  }

  /**
   * Retrieves base URL for API requests based on provider and OpenRouter configuration.
   * @returns Base URL string or null for providers using default URLs
   */
  public getBaseUrl(): string | null {
    // Use centralized check to ensure consistency with getApiKey()
    // Pass the decision to resolveBaseUrl to avoid duplicate checks
    return resolveBaseUrl({
      provider: this.config.provider,
      openRouterOnly: this.config.openRouterOnly,
      customBaseUrl: this.config.baseUrl,
      requiresResponsesAPI: this.config.requiresResponsesAPI,
      useServerSideKeys: this.shouldUseServerSideKeys(),
      logger: this.logger,
    });
  }

  /** Checks if the model is from Anthropic provider. */
  get isAnthropic(): boolean {
    return this.config.provider === ModelProvider.ANTHROPIC;
  }

  /** Checks if the model is from OpenAI provider. */
  get isOpenai(): boolean {
    return this.config.provider === ModelProvider.OPENAI;
  }

  /** Checks if the model is from Google provider. */
  get isGoogle(): boolean {
    return this.config.provider === ModelProvider.GOOGLE;
  }

  /** Checks if the model is from DeepSeek provider. */
  get isDeepSeek(): boolean {
    return this.config.provider === ModelProvider.DEEPSEEK;
  }

  /**
   * Gets streaming configuration for the current model provider.
   * @returns Boolean indicating if streaming should be enabled
   */
  public getStreamingConfig(): boolean {
    if (shouldUseOpenRouter(this.config)) {
      return getProviderStreaming('openrouter');
    }

    // ModelProvider.OTHERS has no provider-specific streaming config
    if (this.config.provider === ModelProvider.OTHERS) {
      return getGlobalStreaming();
    }

    return getProviderStreaming(this.config.provider);
  }

  get isOReasoningModel(): boolean {
    return (
      this.config.provider === ModelProvider.OPENAI &&
      this.capabilities.supportsReasoning
    );
  }

  get isGrokReasoningModel(): boolean {
    return (
      this.config.provider === ModelProvider.XAI &&
      this.capabilities.supportsReasoning
    );
  }

  /**
   * Validates reasoning effort based on provider-specific support
   * @param effort The reasoning effort level to validate
   * @returns Valid reasoning effort string for the current provider
   */
  protected validateReasoningEffort(effort: string): string {
    if (this.config.provider !== ModelProvider.XAI) return effort;
    if (effort === 'low' || effort === 'high') return effort;

    this.logger.warn(
      `xAI models only support 'low' or 'high' reasoning effort. Converting '${effort}' to 'high'.`,
    );
    return 'high';
  }

  /**
   * Returns the effective reasoning effort for the current user and model.
   * Max tier users should not receive xhigh reasoning on GPT-5 models when
   * using included (server-side) access.
   */
  protected getEffectiveReasoningEffort(): ReasoningEffort | null {
    const { supportsReasoningEffort, reasoningEffort } = this.capabilities;
    if (!supportsReasoningEffort || !reasoningEffort) {
      return null;
    }

    if (reasoningEffort === ReasoningEffort.NONE) {
      return null;
    }

    const isGpt5 = this.config.name.startsWith('gpt5');
    if (
      isGpt5 &&
      reasoningEffort === ReasoningEffort.XHIGH &&
      this.shouldUseServerSideKeys()
    ) {
      const userTier = getServerSideKeyService().getUserTier();
      if (userTier === MAX_TIER) {
        return ReasoningEffort.HIGH;
      }
    }

    return reasoningEffort;
  }

  /**
   * Create image/audio messages for the conversation.
   * This is a shared implementation that can be used by all providers.
   * Individual providers can override if needed.
   * @returns Array of media content objects in provider-specific format
   */
  public async createMediaMessage(
    mediaFiles: FileLocation[],
  ): Promise<ReturnType<typeof this.createMediaContent>> {
    const { entries, results } =
      await this.mediaProcessor.loadEntries(mediaFiles);
    this.mediaProcessor.logResults(results);
    return this.createMediaContent(entries);
  }

  /**
   * Evaluates conversation stop conditions based on model response and state.
   * @returns Object with endTurn (should end current turn) and shouldStop (should stop conversation)
   */
  public checkStopConditions(
    stopReason: ProviderStopReason,
    newResponse: string,
    stateRound: ConversationRoundState,
    stateGlobal: AgentRunState,
    agentSetting: AgentSetting,
  ): StopConditionsResult {
    // Compute token-based stop flags
    const totals = stateGlobal.usageAccumulator.getTotals();
    const maxOutputTokens =
      totals.firstInputTokens > 0
        ? this.maxOutputTokensFactor * totals.firstInputTokens
        : Number.POSITIVE_INFINITY;
    const continuationLimitExceeded =
      stateRound.continuationCount > this.continueLimit;
    const inputTokenLimitExceeded =
      totals.totalInputTokens > this.inputTokenLimit;
    const maxOutputTokensExceeded = totals.totalOutputTokens > maxOutputTokens;

    // Detect stop markers in model output
    const endTurnReasons: ProviderStopReason[] = [
      ANTHROPIC_STOP.END_TURN,
      ANTHROPIC_STOP.STOP_SEQUENCE,
      OPENAI_CHAT_FINISH.STOP,
      FinishReason.STOP,
      'STOP', // handle string form returned by some Google clients
    ];
    const endTurn = endTurnReasons.includes(stopReason ?? '');
    const encounterDocumentTag = newResponse.includes(
      `</${agentSetting.documentTag}>`,
    );

    if (maxOutputTokensExceeded) {
      this.logger.warn(
        `Output tokens exceed ${this.maxOutputTokensFactor}x input tokens (total: ${totals.totalOutputTokens}, first input: ${totals.firstInputTokens})`,
      );
    }

    const shouldStop =
      encounterDocumentTag ||
      continuationLimitExceeded ||
      inputTokenLimitExceeded;

    if (shouldStop) {
      this.logger.debug(
        `StopFlags: endTurn: ${endTurn} encounterDocumentTag: ${encounterDocumentTag} continuation_limit: ${continuationLimitExceeded} inputTokenLimit: ${inputTokenLimitExceeded} maxOutputTokens: ${maxOutputTokensExceeded}`,
      );
    }

    return { endTurn, shouldStop };
  }

  public containCutOffMessage(
    content: Array<{ type: string; text?: string }> | string,
  ): boolean {
    if (typeof content === 'string') {
      return content.includes('Your response got cut off');
    }
    return content.some((c) => c.text?.includes('Your response got cut off'));
  }

  /**
   * Creates a continuation message for truncated responses.
   * Shared implementation used by all model handlers that don't support assistant prefill.
   * @returns The formatted continuation message string
   */
  protected createContinuationPrompt(
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
  ): string {
    const prefillTokens = workspaceState.assembly.lastResponse.slice(-K_SLICE);
    const endTag = agentSetting.endTag;
    return `Your response got cut off, because you only have limited response space. Continue responding exactly from where you left off until the very end, marked by ${endTag}. Avoid repeating yourself and avoid starting over. Start your response at the next token after: "${prefillTokens}"`;
  }

  /**
   * Default implementation for models with prefill support.
   * Most models with prefill don't need special continuation handling.
   * Override in subclasses only if custom behavior is needed.
   */
  protected defaultAddContinueWithPrefill(): void {
    this.logger.debug('Skipping continuation - assistant prefill is supported');
  }

  /** Creates and configures a client instance for the specific model provider. */
  abstract getClient(): Promise<C>;

  /**
   * Generates a model response using the provider's API.
   * @param options Options for creating the response
   * @returns Promise resolving to result containing response and optionally updated messages
   */
  abstract createResponse(
    options: CreateResponseOptions<M, C>,
  ): Promise<CreateResponseResult<Resp, M>>;

  /**
   * Creates initial message array for conversation with optional images and system prompt.
   * @returns Promise resolving to provider-specific message array
   */
  abstract initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: FileLocation[],
    systemPrompt?: string,
  ): Promise<M[]>;

  /**
   * Creates messages for follow-up conversation rounds with optional images.
   * @returns Provider-specific message array with new round content
   */
  abstract createRoundMessages(
    messages: M[],
    userMessage: string,
    mediaFiles?: FileLocation[],
  ): Promise<M[]>;

  /**
   * Formats image content into provider-specific message format.
   * @returns Array of formatted image/document content objects
   */
  abstract createMediaContent(mediaMessage: MediaEntry[]): any[];

  /**
   * Extracts the response text and metadata from the model's response object
   * @param responseObject The raw response object from the model
   * @param endTag The end tag to append if needed
   * @returns Object containing response text, usage info, and stop reason
   */
  abstract extractResponse(
    responseObject: any,
    endTag: string,
  ): ExtractResponseResult;

  /**
   * Manages continuation for truncated responses in multi-turn conversations with prefill support.
   * Updates messages array and tool state for next turn.
   */
  abstract addContinueMessageWithPrefill(
    messages: M[],
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
  ): void;

  /**
   * Manages continuation for truncated responses in multi-turn conversations without prefill support.
   * Updates messages array and tool state for next turn.
   */
  abstract addContinueMessageWithoutPrefill(
    messages: M[],
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
  ): void;

  /**
   * Sets up output file and handles content prefilling.
   * @returns Promise resolving to [isComplete: generation complete, messages: updated message array]
   */
  abstract initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: M[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
    prefill: string,
  ): Promise<[boolean, M[]]>;

  /**
   * Calculates API usage cost based on token counts and provider pricing.
   * @returns Total cost in provider's currency units
   */
  abstract computePrice(responseUsage: U): number;

  /**
   * Normalizes provider-specific usage data into a unified format.
   * This is the single source of truth for usage statistics.
   *
   * Cost is computed once here and should never be recomputed elsewhere.
   *
   * @param rawUsage - Raw usage data from the provider's API response
   * @param responseTimeMs - Response time in milliseconds
   * @returns Normalized usage with all metrics in a consistent format
   */
  abstract normalizeUsage(rawUsage: U, responseTimeMs: number): NormalizedUsage;

  /**
   * Updates model message content with response for models with prefill support.
   * Handles cache control and content formatting.
   */
  abstract updateMessageContentWithPrefill(
    messages: M[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void;

  /**
   * Updates model message content with response for models without prefill support.
   * Handles cache control and content formatting.
   */
  abstract updateMessageContentWithoutPrefill(
    messages: M[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void;

  /**
   * Determines if model should continue generating based on response state.
   * @returns Boolean indicating if generation should continue
   */
  abstract shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean;

  /**
   * Extracts thinking content from model responses
   * @param responseObject The raw response object from the model
   * @param workspaceState Optional workspaceState to update with the thinking block
   * @returns The extracted thinking content string or null if no thinking content is available
   */
  abstract processThinkingBlock(
    responseObject: any,
    workspaceState?: AgentWorkspaceState,
  ): string | null;

  /**
   * Extracts tool-use information from provider responses.
   * @param responseObject The raw response object from the model
   * @returns A normalized tool call or null if not present
   */
  abstract extractToolUse(responseObject: Resp): T[];

  /**
   * Build a provider-specific follow-up message containing a tool result.
   *
   * @param client - Provider client (for file uploads if supported)
   * @param call - Parsed tool call object
   * @param result - Tool result payload (binary data stripped, properly typed)
   * @param attachments - Extracted file attachments (for upload/inline if supported)
   * @param workspaceState - Optional workspace state
   * @param text - Optional text to include before tool call
   */
  abstract createToolUseFollowUpMessages(
    client: C | undefined,
    call: T,
    result: ToolResultPayload,
    attachments: ToolFileAttachment[],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<M[]>;

  /**
   * Append a simple text follow-up from the user.
   */
  abstract createUserFollowUpMessages(
    messages: M[],
    userMessage: string,
  ): Promise<M[]>;

  /** Build a simple assistant message from text. */
  abstract createAssistantMessage(text: string): M;

  /**
   * Extract all server tool data in a single pass.
   * Default implementation returns empty results.
   * Override in handlers that support server tools.
   */
  extractServerToolData(_responseObject: Resp): ServerToolExtractionResult {
    return { webSearchResults: [], contentBlocks: [] };
  }

  /** Check if stop reason signals end-turn. */
  public isEndTurnStop(reason: ProviderStopReason): boolean {
    return (
      reason === ANTHROPIC_STOP.END_TURN ||
      reason === MCP_STOP.END_TURN ||
      String(reason).toLowerCase() === 'end_turn' ||
      String(reason).toLowerCase() === 'endturn'
    );
  }

  /**
   * Extract assistant content blocks from a response, excluding tool_use blocks.
   * Default implementation returns empty array for providers without this concept.
   * Override in handlers that support structured content blocks (e.g., Anthropic).
   */
  extractAssistantContent(_responseObject: Resp): unknown[] {
    return [];
  }

  // =========================================================================
  // Message modification methods (for post-build enrichment)
  // =========================================================================

  /**
   * Prepend text to the last user message in the conversation.
   * Used by TeXCountNode to add stats before the user's content.
   *
   * @param messages - Existing messages array (mutated in place)
   * @param text - Text to prepend
   */
  abstract prependTextToUserMessage(messages: M[], text: string): void;

  /**
   * Add media files to the last user message in the conversation.
   * Used by MediaExtractionNode to add figures/PDFs after message building.
   *
   * @param messages - Existing messages array (mutated in place)
   * @param mediaFiles - Media files to add
   */
  abstract addMediaToUserMessage(
    messages: M[],
    mediaFiles: FileLocation[],
  ): Promise<void>;

  // =========================================================================
  // Token counting methods
  // =========================================================================

  /**
   * Validates token limits and computes adjusted max_tokens if needed.
   * Shared implementation used by handlers with native token counting.
   *
   * @param inputTokens - The counted input tokens
   * @param maxTokens - The requested max output tokens
   * @param contextWindow - The model's context window size
   * @param tokenBuffer - Safety buffer to subtract (default: TOKEN_SAFETY_BUFFER)
   * @returns Validation result with adjusted max tokens and utilization info
   * @throws Error if input tokens exceed context window (hard failure)
   */
  protected validateTokenLimits(
    inputTokens: number,
    maxTokens: number,
    contextWindow: number,
    tokenBuffer: number = TOKEN_SAFETY_BUFFER,
  ): TokenValidationResult {
    // Hard fail if input already exceeds context window
    if (inputTokens > contextWindow) {
      throw new Error(
        `Token count of message exceeds context window: ${inputTokens} > ${contextWindow}`,
      );
    }

    const utilizationPercent = (inputTokens / contextWindow) * 100;
    const availableTokens = contextWindow - inputTokens;

    if (availableTokens >= maxTokens) {
      return {
        adjustedMaxTokens: maxTokens,
        inputTokens,
        utilizationPercent,
      };
    }

    const adjustedMaxTokens = computeReducedMaxTokens(
      availableTokens,
      tokenBuffer,
    );

    return {
      adjustedMaxTokens,
      inputTokens,
      utilizationPercent,
    };
  }

  /**
   * Estimates the token count for a set of messages.
   * Override in subclasses to use provider-specific token counting APIs.
   *
   * Providers with native token counting support:
   * - Anthropic: client.messages.countTokens()
   * - Google: client.models.countTokens()
   * - OpenAI Response: client.responses.inputTokens.count()
   * - Kimi/Moonshot: POST /v1/tokenizers/estimate-token-count
   *
   * @param messages - The messages to count tokens for.
   * @param options - Optional additional parameters for token counting.
   * @returns Promise resolving to the total token count.
   * @throws Error if token counting is not supported by this provider.
   */
  async estimateTokenCount(
    _messages: M[],
    _options?: TokenCountOptions<C>,
  ): Promise<number> {
    throw new Error(
      `Token counting not implemented for provider: ${this.config.provider}`,
    );
  }

  /**
   * Whether this handler supports native token counting via API.
   * Override in subclasses that have token counting capability.
   */
  get supportsTokenCounting(): boolean {
    return false;
  }
}
