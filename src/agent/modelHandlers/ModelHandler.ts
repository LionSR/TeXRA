// Third-party imports
import { FinishReason } from '@google/genai';

// Local imports - agent
import {
  type ModelConfig,
  ModelProvider,
  type ModelCapabilities,
  ReasoningEffort,
} from 'llm-zoo';
import { platform } from '@platform/platform';
import type { AgentTrace } from '@agent/trace';
import { logWebFetch, logWebSearch } from '@agent/trace';
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory, type AgentSetting } from '@agent/core/AgentDataclass';
import type {
  ConversationRoundStateSnapshot,
  AgentRunStateSnapshot,
} from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { MediaEntry } from '@agent/utils/mediaTypes';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { K_SLICE } from '@agent/core/constants';
import { getServerSideKeyService } from '@auth/serverKeys';
import { MAX_TIER, FREE_TIER } from '@auth/config';
import { SupabaseClient } from '@auth/SupabaseClient';

// Local imports - platform

// Local imports - model
import { createChannelTrace } from '@logger';
import { getApiKey, type ApiProvider } from '@model/apiProviders';

// Local imports - logger
import { MESSAGE_TYPES } from '@shared/schemas';

// Local imports - tools
import type { ToolFileAttachment } from '@tools/result';

// Local imports - utils
import type { FileLocation } from '@utils/files';
import {
  getProviderStreaming,
  getGlobalStreaming,
} from '@utils/config/providerConfig';
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
  WebFetchResult,
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
  protected logger: AgentTrace;
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
    this.logger = createChannelTrace('Agent');
    this.mediaProcessor = new MediaAttachmentProcessor(this.logger, {
      getCapabilities: () => this.capabilities,
      isOpenAIProvider: () => this.isOpenai,
    });
  }

  public setLogger(logger: AgentTrace): void {
    this.logger = logger;
    this.mediaProcessor.setLogger(logger);
  }

  public setAgentCategory(agentCategory?: AgentCategory | null): void {
    this.agentCategory = agentCategory ?? undefined;
  }

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
   * Returns the effective context window size, accounting for beta overrides.
   * Subclasses may override (e.g. Anthropic 1M beta).
   */
  public getEffectiveContextWindow(): number {
    return this.config.contextWindow;
  }

  /**
   * Returns the effective max output tokens for the current mode.
   * Tool-use agents use a reduced value to leave headroom for context growth.
   */
  protected getEffectiveMaxOutputTokens(): number {
    return this.isToolUseMode()
      ? Math.floor(this.config.maxOutputTokens * TOOL_USE_MAX_OUTPUT_FACTOR)
      : this.config.maxOutputTokens;
  }

  public setOutputStreaming(enabled: boolean): void {
    this.outputStreaming = enabled;
  }

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

  public setProgressViewEnabled(enabled: boolean): void {
    this.progressViewEnabled = enabled;
  }

  /**
   * Convenience wrapper for thinking streams.
   */
  protected createThinkingStream() {
    return this.logger.openStream(MESSAGE_TYPES.THINKING, {
      progressViewEnabled: this.progressViewEnabled,
    });
  }

  /**
   * Convenience wrapper for output streams.
   */
  protected createOutputStream() {
    return this.logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE, {
      progressViewEnabled: this.progressViewEnabled,
    });
  }

  /**
   * Emit web search result to progress view during streaming.
   * This allows search results to appear in correct order based on when
   * they occurred in the response, rather than being logged after streaming.
   */
  protected emitWebSearchResult(result: WebSearchResult): void {
    if (this.progressViewEnabled) {
      logWebSearch(this.logger, result);
    }
  }

  /**
   * Emit web fetch result to progress view during streaming.
   * This allows fetch results to appear in correct order based on when
   * they occurred in the response, rather than being logged after streaming.
   */
  protected emitWebFetchResult(result: WebFetchResult): void {
    if (this.progressViewEnabled) {
      logWebFetch(this.logger, result);
    }
  }

  /**
   * Check if server-side keys should be used for this model.
   *
   * Centralizes the decision to avoid duplication between getApiKey() and getBaseUrl().
   * Both methods call this to ensure consistent routing decisions.
   *
   * Returns true only if ALL of the following hold:
   * 1. Model is NOT routing through OpenRouter (neither openRouterOnly nor global toggle).
   *    OpenRouter always requires an OpenRouter API key; the server-side relay is a
   *    direct-provider path that must not interfere.
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
    // Models routing through OpenRouter (openRouterOnly or global toggle) always use the
    // OpenRouter API — the server-side relay is a direct-provider path, not an OpenRouter
    // path, so it must never take precedence here.
    if (shouldUseOpenRouter(this.config)) {
      return false;
    }
    // Pass short name (this.config.name) for client-side tier validation.
    // The server will separately validate the actual API model name from the request.
    return getServerSideKeyService().shouldUseServerSideKeysSync(
      this.config.provider,
      this.config.name,
    );
  }

  /** Fetch an API key for the given provider, throwing `errorMessage` on failure. */
  private async fetchApiKeyOrThrow(
    provider: ApiProvider,
    errorMessage: string,
  ): Promise<string> {
    try {
      return await getApiKey(platform().secrets, provider);
    } catch (cause) {
      throw new Error(errorMessage, { cause });
    }
  }

  /**
   * Retrieves API key from environment variables based on provider and OpenRouter configuration.
   * When server-side keys are enabled (experimental), returns the user's JWT token instead,
   * which the relay Edge Function will use for authentication.
   *
   * When "Use Included Access" is enabled, only server-side keys are used — no fallback
   * to personal API keys. This ensures runtime behavior matches dropdown availability.
   * Exception: models routed through OpenRouter (openRouterOnly or global toggle) always
   * use the OpenRouter API key regardless of included-access settings, because the
   * server-side relay is a direct-provider path that does not apply to OpenRouter routing.
   *
   * @throws Error if required API key is missing from environment
   */
  public async getApiKey(): Promise<string> {
    const serverSideKeyService = getServerSideKeyService();
    const useIncludedAccess = serverSideKeyService.getUseIncludedModelAccess();

    // Prime caches before using sync methods. This ensures that after reload/continue,
    // the tier config and access status are fetched before shouldUseServerSideKeys() is called.
    // Without this, sync methods return false due to empty caches, causing incorrect tier errors.
    const hasServerAccess = useIncludedAccess
      ? await serverSideKeyService.canUseServerSideKeys()
      : false;

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

    // Models routing through OpenRouter always need the OpenRouter key — included access
    // is a direct-provider relay path and does not apply here.
    if (shouldUseOpenRouter(this.config)) {
      return this.fetchApiKeyOrThrow(
        'openRouter',
        'Missing API key for OpenRouter. Please set it using the "Set API Key" command.',
      );
    }

    if (useIncludedAccess && hasServerAccess) {
      // User is authenticated with "Use Included Access" but model is not available for their tier.
      // Don't fall back to personal API keys - throw an error to match dropdown behavior.
      // Note: We check hasServerAccess to avoid blocking unauthenticated users who have the
      // default useIncludedAccess=true setting but should fall through to personal API keys.
      this.logger.debug(
        `Model "${this.config.name}" not available for tier, useIncludedAccess=true`,
      );
      throw new Error(
        `Model "${this.config.name}" is not available with your current subscription tier. ` +
          `Switch to "Use My Own Keys" via the TeXRA Profile panel, or select a model included in your tier.`,
      );
    }

    return this.fetchApiKeyOrThrow(
      this.config.provider.toLowerCase() as ApiProvider,
      `Missing API key for ${this.config.provider}. Please set it using the "Set API Key" command.`,
    );
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

  /** Checks if the model is from Moonshot/Kimi provider. */
  get isKimi(): boolean {
    return this.config.provider === ModelProvider.MOONSHOT;
  }

  /** Checks if the model is from MiniMax provider. */
  get isMiniMax(): boolean {
    return this.config.provider === ModelProvider.MINIMAX;
  }

  /** Whether this handler supports manual context compaction. Override in subclasses. */
  get supportsManualCompaction(): boolean {
    return false;
  }

  /** Request compaction on the next API call. Override in subclasses that support it. */
  requestCompaction(): void {
    // No-op by default
  }

  /**
   * Gets streaming configuration for the current model provider.
   */
  public getStreamingConfig(): boolean {
    if (shouldUseOpenRouter(this.config))
      return getProviderStreaming('openrouter');
    if (this.config.provider === ModelProvider.OTHERS)
      return getGlobalStreaming();
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
   * On GPT-5 models accessed via included (server-side) keys, xhigh reasoning
   * is capped: Max tier → high, free tier → medium.
   */
  protected getEffectiveReasoningEffort(): ReasoningEffort | null {
    const { supportsReasoningEffort, reasoningEffort } = this.capabilities;
    if (!supportsReasoningEffort || !reasoningEffort) {
      return null;
    }

    // NONE is a deliberate user choice ("minimize reasoning"), not "no preference".
    // Providers map it to their minimum effort level (e.g. Anthropic → 'low').
    // Returning null here would silently fall back to high/default effort.

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
      if (userTier === FREE_TIER) {
        return ReasoningEffort.MEDIUM;
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
    stateRound: ConversationRoundStateSnapshot,
    stateGlobal: AgentRunStateSnapshot,
    agentSetting: AgentSetting,
  ): StopConditionsResult {
    // Compute token-based stop flags
    const totals = stateGlobal.usageAccumulator.totals;
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
    const marker = 'Your response got cut off';
    if (typeof content === 'string') return content.includes(marker);
    return content.some((c) => c.text?.includes(marker));
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
   * Build an assistant message from a provider response.
   *
   * Providers that need to preserve response metadata in conversation history
   * can override this while keeping createAssistantMessage() plain.
   */
  createAssistantMessageFromResponse(_responseObject: Resp, text: string): M {
    return this.createAssistantMessage(text);
  }

  /**
   * Extract all server tool data in a single pass.
   * Default implementation returns empty results.
   * Override in handlers that support server tools.
   */
  extractServerToolData(_responseObject: Resp): ServerToolExtractionResult {
    return { webSearchResults: [], webFetchResults: [], contentBlocks: [] };
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

  /** Default: returns undefined. Concrete handlers override with typed extraction. */
  extractAssistantText(_message: M): string | undefined {
    return undefined;
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

  /**
   * Release any resources held by the handler.
   * Override in subclasses that hold long-lived resources (e.g., WebSocket connections).
   */
  dispose(): void {
    // No-op by default
  }
}
