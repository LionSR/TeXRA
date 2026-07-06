// Standard library imports
import { dirname } from 'node:path';

// Third-party imports
import {
  type ModelConfig,
  ModelProvider,
  type ModelCapabilities,
  ReasoningEffort,
} from 'llm-zoo';

// Local imports - agent
import { platform } from '@platform/platform';
import type { AgentTrace } from '@agent/trace';
import {
  logWebFetch,
  logWebSearch,
  logContextManagementEvent,
} from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  hasEndTag,
  type AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import type {
  ConversationRoundStateSnapshot,
  AgentRunStateSnapshot,
} from '@agent/core/state/AgentState';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import type { StandardPricingConfig } from '@agent/utils/priceUtils';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { K_SLICE } from '@agent/core/constants';
import { getServerSideKeyService } from '@auth/serverKeys';
import { MAX_TIER, FREE_TIER } from '@auth/config';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  getSdkErrorMessage,
  isContextWindowError,
} from '@common/errors/sdkErrorUtils';

// Local imports - platform

// Local imports - model
import { createChannelTrace } from '@logger';
import { getApiKey, type ApiProvider } from '@model/apiProviders';
import { isGpt5ModelName } from '@model/modelNames';

// Local imports - logger
import { MESSAGE_TYPES } from '@shared/schemas';

// Local imports - tools
import type { FileLocation } from '@shared/schemas';
import type {
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas/toolResult';

import { AbsoluteFS, flexibleFS } from '@utils/files';
import { getConfig } from '@utils/config/configUtils';
import {
  getProviderStreaming,
  getGlobalStreaming,
} from '@utils/config/providerConfig';
import {
  computeReducedMaxTokens,
  TOKEN_SAFETY_BUFFER,
  TOOL_USE_SAFETY_BUFFER,
  TOOL_USE_MAX_OUTPUT_FACTOR,
  DEFAULT_COMPACTION_THRESHOLD_PERCENT,
} from './contextManagementConstants';
import { computeUtilizationPercent } from './support/contextUtilization';
import { logCompactionEvent } from './support/compactionLogging';
import { MediaAttachmentProcessor } from './support/MediaAttachmentProcessor';
import {
  resolveBaseUrl,
  shouldUseOpenRouter,
} from './support/ProxyConfigResolver';
import {
  type SdkErrorTagger,
  withSdkErrorTag,
} from './support/sdkErrorTagging';
import {
  ANTHROPIC_STOP,
  GOOGLE_FINISH,
  OPENAI_CHAT_FINISH,
} from './types/StopReasonTypes';
import { prepareExistingOutputContent } from './utils/fileContentUtils';
import { isTokenLimitStopReason } from './utils/stopReasonUtils';

// Type imports
import type { ProviderStopReason } from './types/StopReasonTypes';
import type { ProviderMessage } from './types/ProviderMessage';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  SdkToolCall,
  StopConditionsResult,
  TokenCountOptions,
  TokenValidationResult,
} from './types/ModelHandlerContracts';
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

type UserTextPlacement = 'last-user' | 'continuation';

interface AssistantTextAppendOptions {
  /**
   * True when the current trailing user/system message may be the synthetic
   * continuation prompt. Providers decide whether to append to the previous
   * assistant turn and whether the trailing prompt should be removed.
   */
  readonly afterContinuationPrompt?: boolean;
  /** Provider fallback when converting an existing assistant message shape. */
  readonly fallbackText?: string;
}

// Stop markers that signal a completed turn across providers.
const END_TURN_REASONS: ProviderStopReason[] = [
  ANTHROPIC_STOP.END_TURN,
  ANTHROPIC_STOP.STOP_SEQUENCE,
  OPENAI_CHAT_FINISH.STOP,
  GOOGLE_FINISH.STOP,
];

/**
 * Abstract base class for model-specific handlers that manage API interactions, message processing, and response handling.
 * @template M Provider-specific message type
 * @template U Provider-specific usage type
 * @template T Provider-specific tool call type
 * @template C Provider-specific client type
 * @template Resp Provider-specific response object type
 * @template Media Provider-specific media content block type
 */
export abstract class ModelHandler<
  M extends ProviderMessage = ProviderMessage,
  U = unknown,
  T extends SdkToolCall = SdkToolCall,
  C = unknown,
  Resp = unknown,
  Media = unknown,
> {
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
  protected get canProcessToolResultAttachments(): boolean {
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

  /** Common pricing fields used by providers with standard cache-read rebates. */
  protected standardPricingConfig(): StandardPricingConfig {
    return {
      inputPrice: this.config.inputPrice,
      outputPrice: this.config.outputPrice,
      cacheDiscountFactor: this.capabilities.cacheDiscountFactor,
    };
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
   *
   * Stream-timing contract: subscribers read `stream.start` as "this phase
   * began" (the CLI lights its thinking indicator from it; a started output
   * stream means the model response is underway). By default the start is
   * deferred to the first content chunk — the only universally available
   * signal — so a stream opened at request setup never announces a phase
   * that doesn't happen. A handler that sees an explicit provider phase
   * signal (Anthropic `content_block_start`, OpenAI Responses output items)
   * opens the stream AT that signal with `atPhaseSignal: true`, which emits
   * the start immediately. The safe polarity is the default: a mis-placed
   * call site degrades to first-chunk timing instead of a false indicator.
   */
  protected createThinkingStream(options?: { atPhaseSignal?: boolean }) {
    return this.logger.openStream(MESSAGE_TYPES.THINKING, {
      progressViewEnabled: this.progressViewEnabled,
      deferStart: !options?.atPhaseSignal,
    });
  }

  /**
   * Convenience wrapper for output streams (timing contract above). When
   * output streaming is disabled the stream still announces the response
   * phase (start/end) but withholds the content — workflow runs extract and
   * log the output separately instead of streaming it.
   */
  protected createOutputStream(options?: { atPhaseSignal?: boolean }) {
    return this.logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE, {
      progressViewEnabled: this.progressViewEnabled,
      deferStart: !options?.atPhaseSignal,
      phaseOnly: !this.outputStreaming,
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
  protected async getApiKey(): Promise<string> {
    const serverSideKeyService = getServerSideKeyService();
    const useIncludedAccess = serverSideKeyService.getUseIncludedModelAccess();

    // Prime caches before using sync methods. This ensures that after reload/continue,
    // the tier config and access status are fetched before shouldUseServerSideKeys() is called.
    // Without this, sync methods return false due to empty caches, causing incorrect tier errors.
    const hasServerAccess = useIncludedAccess
      ? await serverSideKeyService.canUseServerSideKeys()
      : false;

    const rules: readonly {
      readonly reason: string;
      readonly matches: () => boolean;
      readonly resolve: () => Promise<string>;
    }[] = [
      {
        reason:
          'Quota auto-switch means the relay was selected but is no longer usable.',
        matches: () =>
          useIncludedAccess && serverSideKeyService.wasQuotaAutoSwitched(),
        resolve: () => {
          throw new Error(
            `Model "${this.config.name}" cannot use the TeXRA relay because your monthly relay quota is exhausted. ` +
              `Switch to "Use My Own Keys" via the TeXRA Profile panel, or wait for the next quota period.`,
          );
        },
      },
      {
        reason: 'Server-side keys authenticate with the Supabase relay token.',
        matches: () => this.shouldUseServerSideKeys(),
        resolve: async () => {
          const accessToken = await SupabaseClient.getRelayAccessToken();
          if (accessToken) {
            this.logger.debug(
              `Using server-side API keys via relay for ${this.config.provider}`,
            );
            return accessToken;
          }
          throw new Error(
            'Unable to authenticate with server. Please sign out and sign back in, or switch to personal API keys.',
          );
        },
      },
      {
        reason:
          'OpenRouter routing always uses the OpenRouter key, not direct-provider relay access.',
        matches: () => shouldUseOpenRouter(this.config),
        resolve: () =>
          this.fetchApiKeyOrThrow(
            'openRouter',
            'Missing API key for OpenRouter. Set your OpenRouter API key to continue.',
          ),
      },
      {
        reason:
          'Included access is enabled and authenticated, but this model is outside the tier.',
        matches: () => useIncludedAccess && hasServerAccess,
        resolve: () => {
          this.logger.debug(
            `Model "${this.config.name}" not available for tier, useIncludedAccess=true`,
          );
          throw new Error(
            `Model "${this.config.name}" is not available with your current subscription tier. ` +
              `Switch to personal API keys, or select a model included in your tier.`,
          );
        },
      },
      {
        reason: 'Personal-key mode uses the configured provider key.',
        matches: () => true,
        resolve: () =>
          this.fetchApiKeyOrThrow(
            this.config.provider.toLowerCase() as ApiProvider,
            `Missing API key for ${this.config.provider}. Set your ${this.config.provider} API key to continue.`,
          ),
      },
    ];

    for (const rule of rules) {
      if (!rule.matches()) continue;
      this.logger.debug(`Resolving API key: ${rule.reason}`);
      return rule.resolve();
    }
    // Defensive only: the final personal-key rule is exhaustive.
    throw new Error('No API key resolution rule matched.');
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
      forceDirectProvider: (this.config as { forceDirectProvider?: boolean })
        .forceDirectProvider,
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

  // The DeepSeek/Kimi/MiniMax provider checks below are intentionally
  // `protected`: their only reader is `ModelHandlerOpenRouterNative` (a
  // subclass), which maps them to capability getters for the providers it
  // proxies. Keeping them off the public `IModelHandler` port avoids leaking
  // provider identity into the SDK surface (the behavioral gates were already
  // converted to capability flags — see the SDK-readiness audit §7/§12).

  /** Checks if the model is from DeepSeek provider. */
  protected get isDeepSeek(): boolean {
    return this.config.provider === ModelProvider.DEEPSEEK;
  }

  /** Checks if the model is from Moonshot/Kimi provider. */
  protected get isKimi(): boolean {
    return this.config.provider === ModelProvider.MOONSHOT;
  }

  /** Checks if the model is from MiniMax provider. */
  protected get isMiniMax(): boolean {
    return this.config.provider === ModelProvider.MINIMAX;
  }

  /**
   * Whether parallel tool calls in a single turn must be batched into one
   * follow-up message to preserve provider-side reasoning / thought signatures.
   * Override in handlers whose APIs require it (Google, DeepSeek, Kimi, MiniMax).
   */
  get requiresBatchedParallelToolResults(): boolean {
    return false;
  }

  /**
   * Whether a user-set reasoning-level override applies to this handler.
   * Defaults to the model's configurable-effort capability; handlers that honor
   * a reasoning level without a granular effort flag override this getter.
   */
  get supportsReasoningLevelOverride(): boolean {
    return this.capabilities.supportsReasoningEffort;
  }

  /** Whether this handler supports manual context compaction. Override in subclasses. */
  get supportsManualCompaction(): boolean {
    return false;
  }

  /**
   * Whether the provider SDK already retries this error internally, so the
   * flow-level auto-retry loop should stand down. Override in subclasses that
   * delegate retries to the provider; the default is no provider-managed retry.
   */
  isAutoRetryManagedByProvider(_error: Error): boolean {
    return false;
  }

  /**
   * Flag to force compaction on the next API call, set by {@link requestCompaction}.
   * Read by the per-provider compaction paths and cleared once compaction is
   * attempted. Inert for handlers that don't run compaction.
   */
  protected compactionRequested = false;

  /** Request compaction on the next API call. */
  requestCompaction(): void {
    this.compactionRequested = true;
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
   * On GPT-5 models accessed via included (server-side) keys, the above-high
   * tiers (xhigh and max) are capped: Max tier → high, free tier → medium.
   */
  protected getEffectiveReasoningEffort(): ReasoningEffort | null {
    const { supportsReasoningEffort, reasoningEffort } = this.capabilities;
    if (!supportsReasoningEffort || !reasoningEffort) {
      return null;
    }

    // NONE is a deliberate user choice ("minimize reasoning"), not "no preference".
    // Providers map it to their minimum effort level (e.g. Anthropic → 'low').
    // Returning null here would silently fall back to high/default effort.

    const isGpt5 = isGpt5ModelName(this.config.name);
    if (
      isGpt5 &&
      (reasoningEffort === ReasoningEffort.XHIGH ||
        reasoningEffort === ReasoningEffort.MAX) &&
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
  protected async createMediaMessage(
    mediaFiles: FileLocation[],
  ): Promise<Media[]> {
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
    const endTurn = END_TURN_REASONS.includes(stopReason ?? '');
    const encounterDocumentTag = newResponse.includes(
      `</${agentSetting.documentTag}>`,
    );

    if (maxOutputTokensExceeded) {
      this.logger.warn('Output tokens exceed input token multiplier', {
        data: {
          maxOutputTokensFactor: this.maxOutputTokensFactor,
          totalOutputTokens: totals.totalOutputTokens,
          firstInputTokens: totals.firstInputTokens,
        },
      });
    }

    const shouldStop =
      encounterDocumentTag ||
      continuationLimitExceeded ||
      inputTokenLimitExceeded;

    if (shouldStop) {
      this.logger.debug('StopFlags', {
        data: {
          endTurn,
          encounterDocumentTag,
          continuationLimitExceeded,
          inputTokenLimitExceeded,
          maxOutputTokensExceeded,
        },
      });
    }

    return { endTurn, shouldStop };
  }

  /**
   * Restore the agent's end tag when the provider's API stripped it.
   *
   * Providers that accept the end tag as an API-level stop sequence
   * (Anthropic `stop_sequences`, OpenAI/OpenRouter `stop`) omit the matched
   * stop text from the returned completion by contract — this puts it back
   * so downstream continuation/extraction logic sees the tag it was told to
   * watch for. Only call this from a caller whose "natural stop" predicate is
   * backed by that same configured stop sequence; each caller supplies its
   * own predicate because provider stop-reason vocabularies differ. Logs
   * when it actually fires, so there's data on how often it's needed.
   */
  protected appendEndTagIfNeeded(
    text: string,
    endTag: string,
    isNaturalStop: boolean,
  ): string {
    if (isNaturalStop && endTag && !text.includes(endTag)) {
      this.logger.debug(
        'appendEndTagIfNeeded: restoring end tag stripped by provider stop sequence',
        { data: { endTag } },
      );
      return `${text}\n${endTag}`;
    }
    return text;
  }

  protected containCutOffMessage(
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

  /** Creates and configures a client instance for the specific model provider. */
  abstract getClient(): Promise<C>;

  /**
   * Provider-specific SDK error tagger. The base {@link createResponse}
   * template wraps {@link createResponseImpl} with this tagger so every thrown
   * error is tagged with structured metadata at the SDK boundary. Override in
   * subclasses that talk to a provider SDK (e.g. `tagOpenAISdkError`).
   * Defaults to a no-op for handlers that don't hit a provider SDK.
   */
  protected get sdkErrorTagger(): SdkErrorTagger {
    return () => {};
  }

  /**
   * Generates a model response using the provider's API.
   *
   * Template method: runs under {@link withCreateResponseGuard}, installs
   * SDK-boundary error tagging via {@link sdkErrorTagger}, then delegates to
   * {@link createResponseImpl}. Subclasses normally override
   * {@link createResponseImpl} (and {@link sdkErrorTagger}); a subclass that
   * needs to bracket the whole call (e.g. a single-turn `inFlight` assertion)
   * overrides only {@link withCreateResponseGuard}.
   *
   * @param options Options for creating the response
   * @returns Promise resolving to result containing response and optionally updated messages
   */
  createResponse(
    options: CreateResponseOptions<M, C>,
  ): Promise<CreateResponseResult<Resp, M>> {
    return this.withCreateResponseGuard(() =>
      withSdkErrorTag(this.sdkErrorTagger, this.config.provider, () =>
        this.createResponseImpl(options),
      ),
    );
  }

  /**
   * Hook to bracket a whole {@link createResponse} call (error tagging +
   * {@link createResponseImpl}). Default: run directly. Override to add a guard
   * such as the single-turn `inFlight` assertion that handlers chaining on a
   * `previous_response_id` / conversation state need. Keeping the error-tag wrap
   * in the base means subclasses supply only the guard, never re-copy the wrap.
   */
  protected withCreateResponseGuard<T>(run: () => Promise<T>): Promise<T> {
    return run();
  }

  /**
   * Provider-specific response generation, invoked by the {@link createResponse}
   * template after error tagging is installed. Subclasses that rely on the base
   * template must override this. Handlers that override {@link createResponse}
   * directly (e.g. the validation stub) never reach this default.
   */
  protected createResponseImpl(
    _options: CreateResponseOptions<M, C>,
  ): Promise<CreateResponseResult<Resp, M>> {
    throw new Error(
      `createResponseImpl not implemented for provider: ${this.config.provider}`,
    );
  }

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
  abstract createMediaContent(mediaMessage: MediaEntry[]): Media[];

  /**
   * Extracts the response text and metadata from the model's response object
   * @param responseObject The raw response object from the model
   * @param endTag The end tag to append if needed
   * @returns Object containing response text, usage info, and stop reason
   */
  abstract extractResponse(
    responseObject: Resp,
    endTag: string,
  ): ExtractResponseResult;

  /**
   * Append provider-shaped user text. `last-user` is for pseudo-prefill
   * instructions that should join the current request; `continuation` is for the
   * synthetic "cut off" prompt added between model calls.
   */
  protected abstract appendUserText(
    messages: M[],
    text: string,
    placement: UserTextPlacement,
  ): void;

  /**
   * Append text to the existing assistant/model turn when the provider message
   * shape allows it. Returns false when the base template should create a fresh
   * assistant message instead.
   */
  protected abstract appendTextToLastAssistantMessage(
    messages: M[],
    text: string,
    options?: AssistantTextAppendOptions,
  ): boolean;

  /**
   * Manages continuation for truncated responses in multi-turn conversations.
   * Models with prefill support don't need special handling (the default is a
   * no-op there); models without it get a continuation prompt appended so the
   * next turn resumes from where the response was cut off. Override the
   * with-prefill branch in subclasses only if custom behavior is needed (e.g.
   * providers without native assistant-prefill continuation).
   */
  addContinueMessage(
    messages: M[],
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
  ): void {
    if (this.capabilities.supportsAssistantPrefill) {
      this.logger.debug(
        'Skipping continuation - assistant prefill is supported',
      );
      return;
    }

    const continuationPrompt = this.createContinuationPrompt(
      workspaceState,
      agentSetting,
    );

    this.logger.debug('Adding continuation message to conversation', {
      data: { continuationMessage: continuationPrompt },
    });
    this.appendUserText(messages, continuationPrompt, 'continuation');
  }

  /**
   * Configured client-side compaction threshold, as a percentage of the context
   * window. Returns 0 when compaction is disabled.
   */
  protected getCompactionThresholdPercent(): number {
    return getConfig<number>(
      'texra.model.compactionThresholdPercent',
      DEFAULT_COMPACTION_THRESHOLD_PERCENT,
    );
  }

  /**
   * Shared threshold check for input-token-based compaction, used by handlers
   * that track a single last-known input-token count. Compaction triggers only
   * in tool-use mode, on a manual request, or when `inputTokens` exceeds the
   * configured percentage of the context window.
   */
  protected shouldCompactByInputTokens(inputTokens: number): boolean {
    if (!this.isToolUseMode()) return false;
    if (this.compactionRequested) return true;

    const thresholdPercent = this.getCompactionThresholdPercent();
    if (thresholdPercent <= 0) return false;

    const threshold = Math.floor(
      (thresholdPercent / 100) * this.config.contextWindow,
    );
    return inputTokens > threshold;
  }

  /**
   * Shared scaffold for client-side conversation compaction (system-prompt-swap
   * summarization). Owns the provider-agnostic parts: separating leading
   * system/developer messages, the too-short guard, assembling the compacted
   * history, success/failure logging, and the error fallback.
   *
   * The provider supplies {@link summarize} (build the request, call the SDK,
   * and return the summary text plus output-token count) and
   * {@link buildSummaryMessage} (wrap the summary into a provider message).
   */
  protected async runClientCompaction(
    messages: M[],
    tokensBefore: number,
    summarize: (
      conversationMessages: M[],
    ) => Promise<{ summaryText: string; outputTokens: number }>,
    buildSummaryMessage: (summary: string) => M,
  ): Promise<{ compactedMessages: M[]; didCompact: boolean }> {
    const contextWindow = this.config.contextWindow;

    // Separate leading system/developer messages from the conversation body.
    const systemMessages: M[] = [];
    const conversationMessages: M[] = [];
    for (const msg of messages) {
      const role = (msg as { role?: string }).role;
      if (
        (role === 'system' || role === 'developer') &&
        conversationMessages.length === 0
      ) {
        systemMessages.push(msg);
      } else {
        conversationMessages.push(msg);
      }
    }

    // Nothing meaningful to summarize if the conversation is too short.
    if (conversationMessages.length <= 2) {
      this.logger.debug('Conversation too short for compaction, skipping');
      return { compactedMessages: messages, didCompact: false };
    }

    try {
      const { summaryText, outputTokens } =
        await summarize(conversationMessages);
      if (!summaryText) {
        this.logger.warn('Compaction returned empty summary, skipping');
        return { compactedMessages: messages, didCompact: false };
      }

      const compactedMessages: M[] = [
        ...systemMessages,
        buildSummaryMessage(summaryText),
      ];

      const estimatedTokensAfter = Math.max(1, outputTokens);
      logCompactionEvent({
        logger: this.logger,
        tokensBefore,
        tokensAfter: estimatedTokensAfter,
        contextWindow,
        details: `Client-side compaction: ${conversationMessages.length} messages summarized`,
        tokensAfterIsEstimate: true,
      });

      return { compactedMessages, didCompact: true };
    } catch (err) {
      this.logger.warn(
        `Compaction failed, continuing with original messages: ${getSdkErrorMessage(err)}`,
        { data: err },
      );
      return { compactedMessages: messages, didCompact: false };
    }
  }

  /**
   * Sets up output file and handles content prefilling.
   * @returns Promise resolving to [isComplete: generation complete, messages: updated message array]
   */
  async initializeOutputAndPrefill(
    _agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: M[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
    prefill: string,
  ): Promise<[boolean, M[]]> {
    if (!(await flexibleFS.existsAndNonTrivial(outputLocation))) {
      if (this.capabilities.supportsAssistantPrefill) {
        if (prefill.length === 0) {
          this.logger.debug(
            'No prefill provided; skipping assistant prefill message',
          );
          return [false, messages];
        }

        this.logger.debug('Adding prefill message', { data: prefill });
        workspaceState.assembly.accumulatedOutput = `${prefill}\n`;
        await AbsoluteFS.ensureDir(dirname(outputLocation.absolutePath));
        await flexibleFS.write(
          outputLocation,
          workspaceState.assembly.accumulatedOutput,
        );
        messages.push(this.createAssistantMessageForPrefillText(prefill));
        return [false, messages];
      }

      if (this.shouldStorePseudoPrefillAsOutput) {
        workspaceState.assembly.accumulatedOutput = prefill;
      }

      if (prefill.length === 0) {
        this.logger.debug(
          'No prefill provided; skipping pseudo-prefill instruction',
        );
        return [false, messages];
      }

      const pseudoPrefill = this.createPseudoPrefillPrompt(prefill);
      this.appendUserText(messages, pseudoPrefill, 'last-user');
      this.logger.debug('Added pseudo-prefill message', {
        data: pseudoPrefill,
      });
      return [false, messages];
    }

    const { fileContent } = await prepareExistingOutputContent(
      outputLocation,
      workspaceState,
      this.logger,
    );

    messages.push(this.createAssistantMessageForPrefillText(fileContent));

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug(
        'End tag detected - skipping model call (response already added above)',
      );
      return [true, messages];
    }

    this.logger.debug(
      'Output file exists but no end tag found - continuing from file',
    );

    if (
      !this.capabilities.supportsAssistantPrefill &&
      this.shouldPrependPrefillOnResumeWithoutAssistantPrefill &&
      !fileContent.includes(prefill)
    ) {
      workspaceState.assembly.accumulatedOutput = prefill + fileContent;
      await flexibleFS.write(
        outputLocation,
        workspaceState.assembly.accumulatedOutput,
      );
    }

    this.addContinueMessage(messages, workspaceState, agentSetting);

    return [false, messages];
  }

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
   * Updates model message content with the latest response. Handles cache
   * control and content formatting, branching on whether the handler supports
   * assistant prefill.
   */
  updateMessageContent(
    messages: M[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    const text = bestConnector + newResponse;

    if (this.capabilities.supportsAssistantPrefill) {
      if (
        this.appendTextToLastAssistantMessage(messages, text, {
          fallbackText: workspaceState.assembly.accumulatedOutput,
        })
      ) {
        return;
      }

      messages.push(this.createAssistantMessageForPrefillText(text));
      return;
    }

    if (
      this.appendTextToLastAssistantMessage(messages, text, {
        afterContinuationPrompt: true,
        fallbackText: workspaceState.assembly.accumulatedOutput,
      })
    ) {
      return;
    }

    messages.push(
      this.createAssistantMessageForAccumulatedOutput(workspaceState),
    );
  }

  /**
   * Determines if model should continue generating based on response state.
   * @returns Boolean indicating if generation should continue
   */
  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    const hasResponseEndTag = hasEndTag(agentSetting, newResponse);
    const shouldContinue =
      isTokenLimitStopReason(stopReason) && !hasResponseEndTag;

    this.logger.debug(
      shouldContinue
        ? `Should continue: token limit reached and end tag '${agentSetting.endTag}' is missing.`
        : `Should not continue: StopReason='${stopReason}', HasEndTag='${hasResponseEndTag}'.`,
    );
    return shouldContinue;
  }

  /** Provider hook for pseudo-prefill prompt wording. */
  protected createPseudoPrefillPrompt(prefill: string): string {
    return `Organize your response with xml tags. Start your response with:\n${prefill}`;
  }

  /** Whether pseudo-prefill should seed accumulated output before the model call. */
  protected get shouldStorePseudoPrefillAsOutput(): boolean {
    return false;
  }

  /** Whether resume should rewrite missing prefill into existing output files. */
  protected get shouldPrependPrefillOnResumeWithoutAssistantPrefill(): boolean {
    return false;
  }

  /** Provider hook for fresh assistant turns after a no-prefill response. */
  protected createAssistantMessageForAccumulatedOutput(
    workspaceState: AgentWorkspaceState,
  ): M {
    return this.createAssistantMessage(
      workspaceState.assembly.accumulatedOutput,
    );
  }

  /** Provider hook for assistant text used as prefill/resume context. */
  protected createAssistantMessageForPrefillText(text: string): M {
    return this.createAssistantMessage(text);
  }

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

  /** Applies a single-string reasoning value to workspace thinking state.
   *  No-op when workspaceState is absent or thinking was already recorded. */
  protected applyStringReasoningToWorkspaceState(
    reasoning: string,
    workspaceState?: AgentWorkspaceState,
  ): void {
    if (workspaceState && !workspaceState.reasoning.thinkingAdded) {
      workspaceState.reasoning.thinkingBlocks = [
        { type: 'thinking', thinking: reasoning },
      ];
      workspaceState.reasoning.thinkingAdded = true;
    }
  }

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
    result: ToolResult,
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
    // Covers ANTHROPIC_STOP.END_TURN ('end_turn') and MCP_STOP.END_TURN
    // ('endTurn') plus any provider casing of the same markers.
    const lower = String(reason).toLowerCase();
    return lower === 'end_turn' || lower === 'endturn';
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

    const utilizationPercent = computeUtilizationPercent(
      inputTokens,
      contextWindow,
    );
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
   * COUNT + VALIDATE template for handlers with native token counting.
   *
   * Wraps the shared {@link validateTokenLimits} in the soft-failure envelope
   * every provider handler otherwise repeats: gated on
   * {@link supportsTokenCounting}, it estimates input tokens via the injected
   * `countTokens` thunk, reduces the requested max-output tokens to fit the
   * context window, emits the `max_tokens_reduced` event, and applies the
   * reduction through the provider-specific `applyReduced` setter.
   *
   * Token-count API failures are soft (proceed without adjustment) — except
   * context-window violations, which are re-thrown so they fail fast. The
   * caller may inject side effects via `onCounted` (e.g. diagnostics) and
   * override the soft-failure path via `onCountFailure` (e.g. a fallback cap).
   *
   * @param params.countTokens Estimates input tokens; closes over built params.
   * @param params.currentMaxTokens The requested max output tokens.
   * @param params.contextWindow The effective context window size.
   * @param params.detailLabel Human-readable `details` for the reduction event.
   * @param params.applyReduced Writes the reduced max back to provider params.
   * @param params.tokenBuffer Safety buffer; defaults to the tool-use-aware buffer.
   * @param params.onCounted Invoked with the counted tokens before validation.
   * @param params.onCountFailure Replaces the default soft-failure debug log.
   */
  protected async applyTokenCountLimit(params: {
    countTokens: () => Promise<number>;
    currentMaxTokens: number;
    contextWindow: number;
    detailLabel: string;
    applyReduced: (adjustedMaxTokens: number) => void;
    tokenBuffer?: number;
    onCounted?: (inputTokens: number) => void;
    onCountFailure?: (err: unknown) => void;
  }): Promise<void> {
    if (!this.supportsTokenCounting) {
      return;
    }
    const {
      countTokens,
      currentMaxTokens,
      contextWindow,
      detailLabel,
      applyReduced,
      onCounted,
      onCountFailure,
    } = params;
    // Token counting uses soft failure: if it fails we proceed without
    // adjustment and let the API enforce limits, avoiding retries for a
    // non-critical operation.
    try {
      const inputTokens = await countTokens();
      onCounted?.(inputTokens);

      // Use a larger safety buffer in tool-use mode unless the caller overrides.
      const tokenBuffer =
        params.tokenBuffer ??
        (this.isToolUseMode() ? TOOL_USE_SAFETY_BUFFER : undefined);
      // Throws if input alone exceeds the context window.
      const validation = this.validateTokenLimits(
        inputTokens,
        currentMaxTokens,
        contextWindow,
        tokenBuffer,
      );

      if (validation.adjustedMaxTokens !== currentMaxTokens) {
        logContextManagementEvent(
          this.logger,
          `Token count (${inputTokens}) + max output tokens (${currentMaxTokens}) exceeds context window (${contextWindow}). Reducing to ${validation.adjustedMaxTokens}.`,
          {
            action: 'max_tokens_reduced',
            tokensBefore: inputTokens,
            contextWindow,
            utilizationBefore:
              validation.utilizationPercent ??
              computeUtilizationPercent(inputTokens, contextWindow),
            originalMaxTokens: currentMaxTokens,
            reducedMaxTokens: validation.adjustedMaxTokens,
            details: detailLabel,
          },
        );
        applyReduced(validation.adjustedMaxTokens);
      }
    } catch (err) {
      this.sdkErrorTagger(err, this.config.provider);
      // Context-window violations are intentional validation errors that must
      // fail fast rather than be swallowed by soft failure.
      if (isContextWindowError(err)) {
        throw err;
      }
      if (onCountFailure) {
        onCountFailure(err);
      } else {
        this.logger.debug(
          'Token counting failed. Proceeding without token adjustment.',
          { data: err },
        );
      }
    }
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
