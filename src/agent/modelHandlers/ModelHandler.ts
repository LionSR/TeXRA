// Node imports
import { createHash } from 'node:crypto';

// Third-party imports
import {
  ModelProvider,
  type ModelCapabilities,
  ReasoningEffort,
} from 'llm-zoo';
// Local imports
import type { AgentTrace } from '@agent/trace';
import {
  attachChannelSubscriber,
  logContextManagementEvent,
  startCompactionActivity,
  TraceEmitter,
} from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
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
import {
  ANTHROPIC_STOP,
  GOOGLE_FINISH,
  isTokenLimitStopReason,
  OPENAI_CHAT_FINISH,
} from '@agent/types/StopReasonTypes';
import type { ProviderStopReason } from '@agent/types/StopReasonTypes';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  ModelCredentialRoute,
  ModelCredentialSelection,
  ResolvedClientCredential,
  SdkToolCall,
  StopConditionsResult,
  TokenCountOptions,
  TokenValidationResult,
} from '@agent/types/ModelHandlerContracts';
import {
  createNeutralResponseTextProcessing,
  type ResponseTextProcessing,
} from '@agent/runtime/responseTextProcessing';
import { hasConfigurableReasoningEffort } from '@agent/modelHandlers/support/reasoningEffort';
import type { ServerToolExtractionResult } from '@agent/types/ServerTools';
import {
  attachContextWindowError,
  attachMissingApiKeyError,
} from '@common/errors/sdkError/errorMetadata';
import {
  isContextWindowError,
  isUserAbort,
} from '@common/errors/sdkError/errorPatterns';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import {
  allowsModelRelay,
  resolveDirectModelApiKeyProvider,
  resolveModelSource,
  type ResolvedModelConfig,
} from '@model/openRouterRouting';
import {
  includedModelAccess,
  INCLUDED_MODEL_ACCESS_REMEDY,
} from '@model/includedModelAccess';
import { getApiKey, type ApiProvider } from '@model/apiProviders';
import { platform } from '@platform/platform';
import { longRunningModelFetch } from '@platform/defaults/longRunningModelTransport';
import type {
  FileLocation,
  MediaAttachmentKind,
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas';
import { MESSAGE_TYPES, AgentCategory } from '@shared/schemas';
import { OUTPUT_END_TAG } from '@shared/schemas/output';
import { INCLUDED_ACCESS, OWN_API_KEYS } from '@shared/copy/modelAccess';
import { DEFAULT_COMPACTION_THRESHOLD_PERCENT } from '@shared/constants/contextManagement';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { extractScratchpad } from '@utils/text/xmlExtraction';
import {
  getProviderStreaming,
  getGlobalStreaming,
} from '@utils/config/providerConfig';
import { getConfig } from '@utils/config/configUtils';

// Local file imports
import {
  computeReducedMaxTokens,
  TOKEN_SAFETY_BUFFER,
  TOOL_USE_SAFETY_BUFFER,
  TOOL_USE_MAX_OUTPUT_FACTOR,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SYSTEM_PROMPT,
} from './contextManagementConstants';
import { roundedUtilizationPercent } from './support/contextUtilization';
import { logCompactionEvent } from './support/compactionLogging';
import { MediaAttachmentProcessor } from './support/MediaAttachmentProcessor';
import {
  reportMediaAttachmentFailure,
  type MediaAttachmentContext,
} from './support/mediaAttachmentPolicy';
import {
  resolveBaseUrl,
  resolveProxyEndpoint,
  shouldUseOpenRouter,
  usesServerSideKeysRoute,
  type ProxyConfig,
} from './support/ProxyConfigResolver';

/**
 * Generic SDK error tagging wrapper used by the base model handler.
 *
 * Provider-specific SDK class checks live beside each provider handler; this
 * module must stay free of provider SDK imports so host startup can load base
 * handler code without pulling OpenAI/Anthropic/Google clients into the eager graph.
 */
type SdkErrorTagger = (err: unknown, provider: string) => void;

interface ClientCompactionResult<M> {
  compactedMessages: M[];
  didCompact: boolean;
}

// Default continuation limits
const DEFAULT_CONTINUE_LIMIT = 10;

// Default token limits
const DEFAULT_INPUT_TOKEN_LIMIT = 1500000;
const DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR = 2.5;

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

function mediaAttachmentKindsFromEntries(
  entries: readonly MediaEntry[],
): MediaAttachmentKind[] {
  return entries.map((entry) =>
    entry.media_category === 'image' && entry.media_type.startsWith('image/')
      ? 'image'
      : 'document',
  );
}

/**
 * Check whether a file exists and contains more than a minimal amount of data.
 *
 * Files shorter than the threshold (15 bytes) are considered trivial and
 * treated as empty artifacts. The value loosely matches the size of empty
 * LaTeX scaffolds produced by latexindent so we can quickly skip placeholder
 * outputs without scanning their contents.
 */
async function existsAndNonTrivial(target: FileLocation): Promise<boolean> {
  if (!(await AbsoluteFS.exists(target.absolutePath))) {
    return false;
  }

  const stats = await AbsoluteFS.stat(target.absolutePath);
  return stats.size > 15;
}

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
  private readonly clientWireIdentities = new WeakMap<
    object,
    {
      route: ModelCredentialRoute;
      credentialIdentity: string;
      usageRoute?: NonNullable<NormalizedUsage['usageRoute']>;
    }
  >();
  private activeAttemptCredentialRoute: ModelCredentialRoute | undefined;
  private lastAttemptCredentialRoute: ModelCredentialRoute | undefined;
  private lastAttemptUsageRoute: NormalizedUsage['usageRoute'];
  /** Set while {@link withSingleTurnGuard} is bracketing a `createResponse`. */
  private singleTurnInFlight = false;
  public config: ResolvedModelConfig;
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
  private readonly insertedAttachmentKinds = new Map<
    MediaAttachmentContext,
    MediaAttachmentKind[]
  >();
  private createdMediaEntriesForAttachmentLog: MediaEntry[] = [];
  protected readonly normalizeResponseText: ResponseTextProcessing['normalizeResponseText'];
  protected readonly postProcessResponse: ResponseTextProcessing['postProcessResponse'];

  /**
   * Whether the handler supports processing attachments in tool results.
   * Override in handlers that don't support attachments (e.g., DeepSeek).
   *
   * Not foldable into a single llm-zoo capability read (#7101 triage):
   * `capabilities.supportsVision` looks like the natural candidate, but it
   * doesn't line up — Grok, Kimi, and Qwen models all report
   * `supportsVision: false` while still relying on this base default of
   * `true` to include a text attachment summary in tool results (see
   * `ModelHandlerOpenAI`/`ModelHandlerOpenRouterNative`), and DeepSeek's
   * override below isn't gating on vision either — DeepSeek's tool-result
   * format doesn't accommodate attachment content at all. Folding this into
   * `supportsVision` would silently drop attachment summaries for every
   * non-vision Grok/Kimi/Qwen model. Stays an overridable getter: genuinely
   * per-provider behavior, not a foldable predicate.
   */
  protected get canProcessToolResultAttachments(): boolean {
    return true;
  }

  /**
   * Whether the handler can upload files to the provider's API for tool results.
   * Override in handlers that support provider-specific file upload APIs
   * (e.g., Anthropic Files API, OpenAI Files API).
   *
   * Not foldable into a single capability read (#7101 triage): Anthropic's
   * override is an unconditional `true` — there's no llm-zoo or
   * `ProviderCapabilityProfile` flag for "has a Files API," it's a
   * provider-wide fact about the Anthropic SDK, not a per-model capability
   * (it would coincidentally match `capabilities.supportsVision`, which is
   * `true` for every current Anthropic model, but that conflates two
   * unrelated capabilities and would break the moment they diverge).
   * OpenAIResponse's override already reads the `ProviderCapabilityProfile`
   * (`getActiveProviderCapabilities()?.openAIResponses`) with a fallback —
   * that one's the "runtime combinator over profile data" bucket, not
   * genuine per-provider behavior. Stays an overridable getter.
   */
  protected get supportsToolResultFileUpload(): boolean {
    return false;
  }

  constructor(
    config: ResolvedModelConfig,
    responseTextProcessing: ResponseTextProcessing = createNeutralResponseTextProcessing(),
  ) {
    this.config = { ...config };
    this.normalizeResponseText = responseTextProcessing.normalizeResponseText;
    this.postProcessResponse = responseTextProcessing.postProcessResponse;
    this.capabilities = structuredClone(config.capabilities);
    this.continueLimit = DEFAULT_CONTINUE_LIMIT;
    this.inputTokenLimit = DEFAULT_INPUT_TOKEN_LIMIT;
    this.maxOutputTokensFactor = DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR;
    // Initialize with default channel, will be overwritten by agent. Unlike
    // the other ~25 log-only `createChannelTrace` singletons, this default
    // is exercised through `createThinkingStream`/`createOutputStream`
    // (`this.logger.openStream(...)`) before `setLogger` swaps in the real
    // per-run trace in some paths, so it needs the full `TraceEmitter`, not
    // the log-only closure `createChannelTrace` now returns.
    this.logger = new TraceEmitter();
    attachChannelSubscriber(this.logger, { channel: 'Agent', isAgent: false });
    this.mediaProcessor = new MediaAttachmentProcessor(this.logger, {
      getCapabilities: () => this.capabilities,
      isOpenAIProvider: () => this.config.provider === ModelProvider.OPENAI,
    });
  }

  /** Fetch implementation with explicit long-stream inactivity timeouts. */
  protected get longRunningModelFetch(): typeof fetch {
    return longRunningModelFetch;
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
   *
   * Runtime combinator (#7101 triage): the only override is
   * `ModelHandlerOpenAIResponse`, which reads
   * `getActiveProviderCapabilities()?.contextWindow` with a fallback to this
   * base value — same "profile read with fallback" shape as
   * `supportsToolResultFileUpload`'s OpenAIResponse override. Not reducible
   * into the base directly since only one subclass implements it, but not
   * genuine per-provider behavior either.
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
   *
   * Not foldable into a single predicate (#7101 triage): the two overriding
   * handlers compute this with materially different formulas, not just
   * different booleans. `ModelHandlerGoogleInteractions` gates on server
   * state plus a workflow-mode eligibility check and a config toggle
   * (`useBackgroundMode(this.serverStateEnabled())`).
   * `ModelHandlerOpenAIResponse` gates on `backgroundModeSupported`, its own
   * toggle/eligibility checks, *and* a `ProviderCapabilityProfile` override
   * (`getOpenAIResponseCapabilities()?.backgroundMode === 'disabled'`) that
   * can force it off regardless of the other checks. `ModelHandlerOpenRouterNative`
   * doesn't override this at all — it correctly inherits the base `false`,
   * and since the base is a plain constant rather than a `config.provider`
   * read, there's no OpenRouterNative-shares-config.provider risk here (see
   * `requiresPerCallSystemPrompt`'s note on that failure mode). Stays an
   * overridable method.
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
   *
   * Runtime combinator over profile data, not a foldable predicate (#7101
   * triage): no handler overrides this getter — grepped across every
   * `ModelHandler*` subclass, none redefine it — so it stays a single base
   * implementation whose inputs (`this.config.provider`, `this.config.name`,
   * `this.config.openRouterOnly`, `this.config.requiresResponsesAPI`) are
   * already plain profile reads, no handler-level or stringly model-family
   * logic feeding it. The combinator formula itself lives in
   * {@link usesServerSideKeysRoute} so `UsageMonitor` — which deliberately
   * holds only a `ModelConfig`-shaped value, not a full handler instance —
   * shares it instead of re-deriving the same `!openRouter && relaySync`
   * check independently.
   */
  protected shouldUseServerSideKeys(): boolean {
    if (this.activeAttemptCredentialRoute !== undefined) {
      return this.activeAttemptCredentialRoute === 'relay';
    }
    return usesServerSideKeysRoute(this.config);
  }

  /**
   * Fetch an API key for the given provider, throwing `errorMessage` on
   * failure. This is the one producer of the missing-credential fact the run
   * lifecycle sees, so the throw carries a typed marker: `classifyAgentError`
   * reads it instead of matching `errorMessage`, whose per-provider wording
   * this method owns and reworded freely before (the OpenRouter variant never
   * matched the substrings the classifier used to look for).
   */
  private async fetchApiKeyOrThrow(
    provider: ApiProvider,
    errorMessage: string,
  ): Promise<string> {
    try {
      return await getApiKey(platform().secrets, provider);
    } catch (cause) {
      const error = new Error(errorMessage, { cause });
      attachMissingApiKeyError(error);
      throw error;
    }
  }

  /**
   * Resolve the credential and endpoint together for one client construction.
   * The returned value is immutable and no later request step needs to reread
   * the process-wide access settings. `personal` bypasses included relay
   * access but preserves model-owned routes such as OpenRouter-only models.
   */
  protected async resolveClientCredential(
    selection: ModelCredentialSelection = 'configured',
  ): Promise<ResolvedClientCredential> {
    const useOpenRouter = shouldUseOpenRouter(this.config);
    const includedAccess =
      selection === 'configured' ? includedModelAccess() : null;
    const useIncludedAccess =
      includedAccess?.getUseIncludedModelAccess() ?? false;
    const canRouteThroughRelay =
      useIncludedAccess && !useOpenRouter && allowsModelRelay(this.config);
    const hasServerAccess = canRouteThroughRelay
      ? await includedAccess?.canUseServerSideKeys()
      : false;

    if (canRouteThroughRelay && includedAccess?.wasQuotaAutoSwitched()) {
      throw new Error(
        `Model "${this.config.name}" is unavailable. ${INCLUDED_ACCESS.usedUp.statement} ` +
          INCLUDED_ACCESS.usedUp.nextStep,
      );
    }

    const useRelay =
      canRouteThroughRelay &&
      includedAccess?.shouldUseServerSideKeysSync(
        this.config.provider,
        this.config.name,
      );
    if (useRelay) {
      const apiKey = await includedAccess?.getAccessToken();
      if (!apiKey) {
        throw new Error(
          `Unable to authenticate with server. Sign out and sign back in, or switch to ${OWN_API_KEYS.inline}.`,
        );
      }
      this.logger.debug(
        `Using server-side API keys via relay for ${this.config.provider}`,
      );
      return {
        apiKey,
        baseUrl: resolveBaseUrl(this.buildProxyConfig(true, false)),
        route: 'relay',
      };
    }

    if (useIncludedAccess && hasServerAccess) {
      throw new Error(
        `Model "${this.config.name}" is not available with your current subscription tier. ` +
          `Switch to ${OWN_API_KEYS.inline}, or select a model included in your tier.`,
      );
    }

    const provider = useOpenRouter
      ? 'openRouter'
      : resolveDirectModelApiKeyProvider(this.config);
    if (!provider) {
      throw new Error(
        `Model "${this.config.name}" has no direct API-key provider.`,
      );
    }
    // Name both ways out. Included access being off is a configuration state,
    // not an absence of one, so "missing key" alone would send a user with a
    // subscription hunting for a key they should not need.
    const apiKey = await this.fetchApiKeyOrThrow(
      provider,
      useOpenRouter
        ? `Missing OpenRouter API key. Set an OpenRouter API key in settings.`
        : `Missing API key for ${provider}. ${INCLUDED_MODEL_ACCESS_REMEDY}`,
    );
    const endpoint = resolveProxyEndpoint(
      this.buildProxyConfig(false, useOpenRouter),
    );
    return {
      apiKey,
      baseUrl: endpoint.baseUrl,
      route: useOpenRouter ? 'openrouter' : 'api-key',
      ...('usageRoute' in endpoint && { usageRoute: endpoint.usageRoute }),
    };
  }

  /**
   * Build the {@link ProxyConfig} route for the current config plus a
   * caller-resolved server-side-keys / OpenRouter decision. A per-model
   * custom base URL always wins over both, matching `resolveBaseUrl`'s
   * documented precedence — encoding that choice here (rather than at each
   * call site) is what keeps `useServerSideKeys` and `useOpenRouter` from
   * ever being set together on the same `ProxyConfig`.
   */
  private buildProxyConfig(
    useServerSideKeys: boolean,
    useOpenRouter: boolean,
  ): ProxyConfig {
    if (this.config.baseUrl) {
      return { route: 'custom', url: this.config.baseUrl, logger: this.logger };
    }
    if (useServerSideKeys) {
      return {
        route: 'serverSideKeys',
        provider: this.config.provider,
        logger: this.logger,
      };
    }
    return {
      route: 'direct',
      provider: this.config.provider,
      useOpenRouter,
      logger: this.logger,
    };
  }

  /** Associate a constructed SDK client with the route it captured. */
  protected rememberClientCredentialRoute<Candidate extends object>(
    client: Candidate,
    route: ModelCredentialRoute,
    credentialSecret: string,
  ): Candidate {
    // Relay and subscription routes have stable route identities so ordinary
    // token rotation does not split recovery coordination; direct credentials
    // use a non-secret fingerprint so distinct keys stay distinct routes.
    const credentialIdentity =
      route === 'relay' ||
      route === 'chatgpt-subscription' ||
      route === 'xai-subscription'
        ? route
        : createHash('sha256')
            .update(route)
            .update('\0')
            .update(credentialSecret)
            .digest('base64url');
    this.clientWireIdentities.set(client, { route, credentialIdentity });
    return client;
  }

  /** Associate a constructed client with a more precise accounting route. */
  protected rememberClientUsageRoute<Candidate extends object>(
    client: Candidate,
    route: NonNullable<NormalizedUsage['usageRoute']>,
  ): Candidate {
    const identity = this.clientWireIdentities.get(client);
    if (!identity) throw new Error('Client credential route is not registered');
    identity.usageRoute = route;
    return client;
  }

  /** Route of the credential a client built by this handler captured, if known. */
  getCredentialRouteForClient(client: C): ModelCredentialRoute | undefined {
    return typeof client === 'object' && client !== null
      ? this.clientWireIdentities.get(client)?.route
      : undefined;
  }

  /**
   * Stable key for the wire route this client's requests share: provider,
   * credential route, endpoint, and a non-secret credential identity. Owned
   * here so the retry gate's key format has a single owner; the flow layer
   * treats it as opaque.
   */
  getWireRouteKey(client: C): string {
    const wireIdentity =
      typeof client === 'object' && client !== null
        ? this.clientWireIdentities.get(client)
        : undefined;
    return JSON.stringify([
      this.config.provider,
      wireIdentity?.route ?? 'configured',
      this.getRetryEndpoint(client),
      wireIdentity?.credentialIdentity ?? 'unknown-credential',
    ]);
  }

  /**
   * Stable recovery key for limits that apply to one model on a wire route.
   * Transport health deliberately stays on getWireRouteKey so an outage still
   * coordinates every model sharing the credential and endpoint.
   */
  getModelRetryRouteKey(client: C): string {
    return JSON.stringify([this.getWireRouteKey(client), this.config.fullName]);
  }

  /** Route currently executing, excluding the last completed attempt. */
  protected get activeCredentialRoute(): ModelCredentialRoute | undefined {
    return this.activeAttemptCredentialRoute;
  }

  /** Route tag for usage recorded after a successful attempt. */
  getLastCredentialUsageRoute(): NormalizedUsage['usageRoute'] {
    if (this.lastAttemptUsageRoute !== undefined) {
      return this.lastAttemptUsageRoute;
    }
    const route = this.lastAttemptCredentialRoute;
    switch (route) {
      case 'chatgpt-subscription':
        return 'chatgpt-subscription';
      case 'xai-subscription':
        return 'xai-subscription';
      case 'relay':
        return 'relay';
      case 'api-key':
      case 'openrouter':
        return 'api-key';
      case undefined:
        return undefined;
      default:
        // A new route must pick its own usage tag here: untagged usage is
        // dropped silently by the caller rather than reported.
        route satisfies never;
        return undefined;
    }
  }

  /** Resolve the key from the same atomic route used by client construction. */
  protected async getApiKey(): Promise<string> {
    return (await this.resolveClientCredential()).apiKey;
  }

  /**
   * Retrieves base URL for API requests based on provider and OpenRouter configuration.
   * @returns Base URL string or null for providers using default URLs
   */
  public getBaseUrl(): string | null {
    const activeRoute = this.activeAttemptCredentialRoute;
    // Use centralized check to ensure consistency with getApiKey()
    // Pass the decision along to avoid duplicate checks
    const useOpenRouter =
      activeRoute !== undefined
        ? activeRoute === 'openrouter'
        : shouldUseOpenRouter(this.config);
    return resolveBaseUrl(
      this.buildProxyConfig(this.shouldUseServerSideKeys(), useOpenRouter),
    );
  }

  /** Stable endpoint identity used to coordinate retries for one client. */
  public getRetryEndpoint(_client: C): string {
    return this.getBaseUrl() ?? `${this.config.provider}:default`;
  }

  // Provider-identity getters (isAnthropic/isOpenai/isGoogle/…) were removed
  // (#7101): `config.provider` is already part of the `IModelHandler` port, so
  // callers compare it against `ModelProvider` directly. The #7101 triage of
  // every remaining predicate is complete: each carries its own note on why it
  // stays (runtime combinator, or genuinely per-provider behavior), so there is
  // nothing left to fold here.

  /**
   * Whether parallel tool calls in a single turn must be batched into one
   * follow-up message to preserve provider-side reasoning / thought signatures.
   * Override in handlers whose APIs require it (Google, DeepSeek, Kimi, MiniMax).
   *
   * Not foldable into a single llm-zoo capability read (#7101 triage):
   * `capabilities.supportsReasoning`/`supportsInterleavedThinking` look like
   * the natural backing flags, but neither lines up. `ReasoningModelHandlerOpenAI`
   * (the shared base for DeepSeek/Kimi/MiniMax) overrides this to an
   * unconditional `true` for every model in those families, including
   * non-reasoning variants — llm-zoo reports `supportsReasoning: false` for
   * `dsv3`, `kimi`, and `kimi2`, yet they still batch, because the requirement
   * is a provider-wire-format fact (there's a reasoning channel to preserve
   * across the whole family's API), not a per-model reasoning toggle.
   * `ModelHandlerGLM` overrides it back to `false` even for its
   * reasoning-capable variants (`glm45`, `glm52`). Grok reasoning models
   * (`grok43`, `grok3-`) likewise stay at this `false` default through
   * `ModelHandlerXAI`. Folding this into `supportsReasoning` would wrongly
   * force batching on non-reasoning DeepSeek/Kimi/MiniMax variants and wrongly
   * skip it for reasoning Grok models. Stays an overridable getter: genuinely
   * per-provider behavior, not a foldable predicate.
   */
  get requiresBatchedParallelToolResults(): boolean {
    return false;
  }

  /**
   * Whether a user-set reasoning-level override applies to this handler.
   * True for the model's configurable-effort capability, or for DeepSeek
   * models (native or proxied via OpenRouter) that support reasoning without
   * a granular effort flag.
   *
   * Runtime combinator (#7101 triage): `ModelHandlerDeepSeek` is only ever
   * constructed for `ModelProvider.DEEPSEEK` (see `ModelFactory.ts`'s
   * `PROVIDER_HANDLER_ROUTES`), so `config.provider === ModelProvider.DEEPSEEK`
   * there is always true and this reduces to its former override exactly.
   * For every other handler besides `ModelHandlerOpenRouterNative` — which
   * gets its own paragraph below — `config.provider` is never
   * `ModelProvider.DEEPSEEK`, so this reduces to the former plain
   * `supportsReasoningEffort` default. And this is verified identical to
   * `ModelHandlerOpenRouterNative`'s pre-existing override (which already
   * gated on `config.provider === ModelProvider.DEEPSEEK` since
   * OpenRouterNative shares `config.provider` with the underlying model —
   * see that predicate's own #7101 note on `requiresPerCallSystemPrompt`).
   */
  get supportsReasoningLevelOverride(): boolean {
    return (
      hasConfigurableReasoningEffort(this.config.capabilities) ||
      (this.config.provider === ModelProvider.DEEPSEEK &&
        this.config.capabilities.supportsReasoning)
    );
  }

  /**
   * Whether this handler supports manual (user-requested) context compaction.
   * Each override computes this differently — Anthropic combines llm-zoo
   * model-family eligibility with workflow/tool-use mode, OpenAI-family handlers gate
   * on tool-use mode alone, OpenAIResponse reads the ChatGPT-subscription
   * profile with an OpenRouter-routing fallback, and GoogleInteractions is
   * unconditionally true — so no single capability-profile read replaces the
   * per-handler logic. Stays an overridable getter (#7101 triage: genuinely
   * per-provider behavior, not a foldable predicate).
   */
  get supportsManualCompaction(): boolean {
    return false;
  }

  /** Whether this provider can force one named tool on a model request. */
  get supportsForcedToolChoice(): boolean {
    return false;
  }

  /**
   * Whether this handler needs the system prompt resupplied on every call via
   * `createResponse({ systemPrompt })`, rather than embedded once into
   * `messages` at session init. True for providers whose `system` parameter
   * is per-call (Anthropic, Google); false for providers that embed system
   * text into `messages[0]` in `initializeMessages` (OpenAI, OpenRouter),
   * where resupplying it per-call would duplicate it alongside the persisted
   * message.
   *
   * Not foldable into a `config.provider` comparison at the call site
   * (#7101 triage): `ModelHandlerOpenRouterNative` extends this base class
   * directly rather than `ModelHandlerAnthropic`/`*GoogleGenAI`, but
   * `ModelFactory` constructs it with `{ ...config }` — an Anthropic- or
   * Google-provider model routed through OpenRouter keeps
   * `config.provider === ANTHROPIC/GOOGLE` while embedding the system
   * prompt into `messages` like OpenAI, not resupplying it per-call. Only
   * the polymorphic override (which OpenRouterNative doesn't inherit)
   * distinguishes "this concrete handler resupplies per-call" from
   * "the underlying model family happens to be Anthropic/Google" — a
   * `config` field comparison can't reproduce that distinction, since
   * whether a request routes through OpenRouterNative is decided by
   * `ModelFactory` from the ambient `useOpenRouter` setting, not persisted
   * on `config` itself.
   */
  get requiresPerCallSystemPrompt(): boolean {
    return false;
  }

  /**
   * Whether compaction is forced on the next API call. Private so that every
   * set and clear carries an ownership token: a handler-internal compaction
   * request (pre-flight threshold, overflow recovery) must mint a FRESH token
   * via {@link requestCompaction}, otherwise the flow's
   * {@link clearCompactionRequest} for an older request would cancel it.
   * Inert for handlers that don't run compaction.
   */
  private compactionRequested = false;
  private compactionRequestId = 0;

  /**
   * A successful client-side compaction whose generation request has not yet
   * succeeded. The outer model node may repeat the same input after a
   * transport failure; retaining the compacted payload prevents another paid
   * summarization call. A successful generation commits the payload to the
   * flow and clears this pending value.
   *
   * Reuse is guarded by a content fingerprint, not just array identity: after
   * a failed turn the root tool-use flow appends the user's follow-up onto
   * the SAME messages array (a push, or — for Google Interactions — an
   * in-place merge into the last step), and replaying the stale pre-follow-up
   * payload would silently drop that message from the request and, via the
   * flow's in-place commit, from the conversation history.
   */
  private pendingClientCompaction?: {
    sourceMessages: M[];
    sourceFingerprint: string;
    result: ClientCompactionResult<M>;
  };

  /** Cheap mutation detector for a messages array reused across attempts:
   *  follow-ups either push (length changes) or merge into the last message
   *  in place (its serialized size changes). */
  protected messagesTailFingerprint(messages: M[]): string {
    const last = messages.at(-1);
    return `${messages.length}:${last === undefined ? 0 : JSON.stringify(last).length}`;
  }

  /** Request compaction on the next API call and return its ownership token. */
  requestCompaction(): number {
    this.compactionRequested = true;
    this.compactionRequestId += 1;
    return this.compactionRequestId;
  }

  /** Snapshot the ownership token for the currently pending request. */
  protected getPendingCompactionRequestId(): number | undefined {
    return this.compactionRequested ? this.compactionRequestId : undefined;
  }

  /** Whether a compaction request is pending, without consuming it. */
  protected isCompactionRequested(): boolean {
    return this.compactionRequested;
  }

  /**
   * Consume a pending compaction request: reports whether one was pending and
   * clears it. The token is deliberately not advanced — a later
   * {@link clearCompactionRequest} for the consumed request is already a no-op
   * on the cleared flag, while a new request minted meanwhile carries a newer
   * token that the stale clear cannot match.
   */
  protected consumeCompactionRequest(): boolean {
    const requested = this.compactionRequested;
    this.compactionRequested = false;
    return requested;
  }

  /** Clear a pending compaction request only while the caller still owns it. */
  clearCompactionRequest(requestId: number): void {
    if (requestId !== this.compactionRequestId) {
      return;
    }
    this.compactionRequested = false;
  }

  /**
   * Gets streaming configuration for the current model provider.
   */
  public getStreamingConfig(): boolean {
    if (shouldUseOpenRouter(this.config))
      return getProviderStreaming('openrouter');
    if (this.config.provider === ModelProvider.OTHERS)
      return getGlobalStreaming();
    return getProviderStreaming(
      resolveModelSource(this.config) ?? this.config.provider,
    );
  }

  /**
   * Normalizes a reasoning-effort value for the concrete handler.
   * Provider handlers override this hook when their API supports a narrower
   * vocabulary.
   */
  protected validateReasoningEffort(effort: string): string {
    return effort;
  }

  /**
   * Returns the effective reasoning effort for the current user and model.
   * A request served through included access gets whatever effort that relay
   * will honor — which tiers of it may cap. Which models are capped and to what
   * is the relay operator's pricing policy, so it lives with the installed
   * {@link IncludedModelAccess} rather than in every provider handler; a direct
   * API key is billed to the user and is never capped.
   */
  protected getEffectiveReasoningEffort(): ReasoningEffort | null {
    const { supportsReasoningEffort, reasoningEffort } = this.capabilities;
    if (!supportsReasoningEffort || !reasoningEffort) {
      return null;
    }

    // NONE stays a value, not a null: it is a deliberate user choice
    // ("minimize reasoning") that providers map to their minimum effort level
    // (e.g. Anthropic → 'low'), while null would fall back to default effort.
    return this.shouldUseServerSideKeys()
      ? includedModelAccess().capReasoningEffort(
          this.config.name,
          reasoningEffort,
        )
      : reasoningEffort;
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
    this.setCreatedMediaEntriesForAttachmentLog(entries);
    return this.createMediaContent(entries);
  }

  protected setCreatedMediaEntriesForAttachmentLog(
    entries: readonly MediaEntry[],
  ): void {
    this.createdMediaEntriesForAttachmentLog = [...entries];
  }

  public consumeInsertedAttachmentKinds(
    context: MediaAttachmentContext,
  ): MediaAttachmentKind[] {
    const kinds = this.insertedAttachmentKinds.get(context) ?? [];
    this.insertedAttachmentKinds.set(context, []);
    return [...kinds];
  }

  /**
   * Single call-through for building a round's media content (#7465): every
   * `initializeMessages` / `createRoundMessages` / `addMediaToUserMessage`
   * override across providers calls this instead of wrapping
   * `createMediaMessage` in its own try/catch. The fail-vs-warn decision
   * lives in {@link reportMediaAttachmentFailure} alone, so every provider's
   * initial round fails the same way and every provider's follow-up/insert
   * round warns-and-continues the same way — see that function for why the
   * split exists.
   */
  protected async createMediaForRound(
    mediaFiles: FileLocation[],
    context: MediaAttachmentContext,
  ): Promise<Media[]> {
    this.insertedAttachmentKinds.set(context, []);
    this.setCreatedMediaEntriesForAttachmentLog([]);
    try {
      const media = await this.createMediaMessage(mediaFiles);
      if (media.length > 0) {
        this.insertedAttachmentKinds.set(
          context,
          mediaAttachmentKindsFromEntries(
            this.createdMediaEntriesForAttachmentLog,
          ),
        );
      }
      return media;
    } catch (err) {
      reportMediaAttachmentFailure(this.logger, context, err);
      return [];
    }
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
    const encounterDocumentTag = newResponse.includes(OUTPUT_END_TAG);

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

  /** Creates and configures a client instance for the specific model provider. */
  abstract getClient(selection?: ModelCredentialSelection): Promise<C>;

  /**
   * Rebuild a client for an explicit route without publishing settings.
   *
   * This is a deliberate override seam, not a redundant alias for
   * {@link getClient}. `ModelHandlerGoogleInteractions` caches its SDK client
   * across calls; its override clears that cache here so `refreshClient`
   * never reuses a cached instance, even when the resolved credential matches
   * the cached one. Handlers without a cache keep the base pass-through
   * default.
   */
  async refreshClient(
    selection: ModelCredentialSelection = 'configured',
  ): Promise<C> {
    return this.getClient(selection);
  }

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
   * needs to bracket the whole call (e.g. the {@link withSingleTurnGuard}
   * assertion) overrides only {@link withCreateResponseGuard}.
   *
   * @param options Options for creating the response
   * @returns Promise resolving to result containing response and optionally updated messages
   */
  createResponse(
    options: CreateResponseOptions<M, C>,
  ): Promise<CreateResponseResult<Resp, M>> {
    let credentialRoute: ModelCredentialRoute | undefined;
    if (typeof options.client === 'object' && options.client !== null) {
      credentialRoute = this.clientWireIdentities.get(options.client)?.route;
    }
    return this.withCreateResponseGuard(async () => {
      this.activeAttemptCredentialRoute = credentialRoute;
      this.lastAttemptCredentialRoute = credentialRoute;
      this.lastAttemptUsageRoute =
        typeof options.client === 'object' && options.client !== null
          ? this.clientWireIdentities.get(options.client)?.usageRoute
          : undefined;
      try {
        return await this.createResponseImpl(options);
      } catch (err) {
        this.sdkErrorTagger(err, this.config.provider);
        throw err;
      } finally {
        this.activeAttemptCredentialRoute = undefined;
      }
    }).then((result) => {
      // The caller can now commit result.updatedMessages. Retaining the
      // pending payload beyond this point could reuse it for a later turn if
      // the caller mutates the same message array in place.
      this.pendingClientCompaction = undefined;
      return result;
    });
  }

  /**
   * Hook to bracket a whole {@link createResponse} call (error tagging +
   * {@link createResponseImpl}). Default: run directly. Handlers that chain on
   * a `previous_response_id` / conversation state override it with
   * {@link withSingleTurnGuard}. Keeping the error-tag wrap in the base means
   * subclasses supply only the guard, never re-copy the wrap.
   */
  protected withCreateResponseGuard<T>(run: () => Promise<T>): Promise<T> {
    return run();
  }

  /**
   * {@link withCreateResponseGuard} implementation for handlers that are
   * single-turn per instance. Concurrent callers would race the handler's
   * conversation-chain bookkeeping, so the second call fails loudly instead of
   * corrupting it silently.
   *
   * @param handlerName Module name reported in the assertion message.
   */
  protected async withSingleTurnGuard<T>(
    handlerName: string,
    run: () => Promise<T>,
  ): Promise<T> {
    if (this.singleTurnInFlight) {
      throw new Error(
        `${handlerName}.createResponse invoked while a prior ` +
          'call is still in flight; this handler is single-turn per instance.',
      );
    }
    this.singleTurnInFlight = true;
    try {
      return await run();
    } finally {
      this.singleTurnInFlight = false;
    }
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
   * Formats media entries into provider-specific content blocks for the base
   * {@link createMediaMessage} template. Providers that render media through
   * that template override this; providers that override `createMediaMessage`
   * wholesale (e.g. the Google handlers, which upload/inline media directly)
   * never reach this path and inherit the default, which fails clearly rather
   * than emitting a malformed payload if a future change ever routes media
   * through the base template without supplying a conversion.
   * @returns Array of formatted image/document content objects
   */
  createMediaContent(_mediaMessage: MediaEntry[]): Media[] {
    throw new Error(
      `${this.constructor.name}.createMediaContent is not implemented: ` +
        'override it, or override createMediaMessage to build media directly.',
    );
  }

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

  /** Append a provider-shaped continuation prompt as a fresh message. */
  protected abstract appendUserText(messages: M[], text: string): void;

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
    _agentSetting: AgentSetting,
  ): void {
    if (this.capabilities.supportsAssistantPrefill) {
      this.logger.debug(
        'Skipping continuation - assistant prefill is supported',
      );
      return;
    }

    const prefillTokens = workspaceState.assembly.lastResponse.slice(-K_SLICE);
    const continuationPrompt = `Your response got cut off, because you only have limited response space. Continue responding exactly from where you left off until the very end, marked by ${OUTPUT_END_TAG}. Avoid repeating yourself and avoid starting over. Start your response at the next token after: "${prefillTokens}"`;

    this.logger.debug('Adding continuation message to conversation', {
      data: { continuationMessage: continuationPrompt },
    });
    this.appendUserText(messages, continuationPrompt);
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
    if (this.isCompactionRequested()) return true;

    const thresholdPercent = this.getCompactionThresholdPercent();
    if (thresholdPercent <= 0) return false;

    const threshold = Math.floor(
      (thresholdPercent / 100) * this.getEffectiveContextWindow(),
    );
    return inputTokens > threshold;
  }

  /**
   * Runs input-token-driven compaction when the shared threshold policy selects
   * the current conversation. The trigger, request consumption, and diagnostic
   * context stay uniform while each provider retains its SDK-specific summary
   * request and message representation.
   */
  protected async maybeCompactByInputTokens(
    messages: M[],
    inputTokens: number,
    compact: () => Promise<ClientCompactionResult<M>>,
  ): Promise<ClientCompactionResult<M>> {
    if (
      this.pendingClientCompaction?.sourceMessages === messages &&
      this.pendingClientCompaction.sourceFingerprint ===
        this.messagesTailFingerprint(messages)
    ) {
      return this.pendingClientCompaction.result;
    }
    this.pendingClientCompaction = undefined;

    if (!this.shouldCompactByInputTokens(inputTokens)) {
      return { compactedMessages: messages, didCompact: false };
    }

    const manuallyRequested = this.consumeCompactionRequest();

    const thresholdPercent = this.getCompactionThresholdPercent();
    const contextWindow = this.getEffectiveContextWindow();
    this.logger.debug(
      manuallyRequested
        ? 'Compacting conversation (manually requested)'
        : 'Compacting conversation (token threshold exceeded)',
      {
        data: {
          inputTokens,
          utilizationPercent: roundedUtilizationPercent(
            inputTokens,
            contextWindow,
          ),
          contextWindow,
          ...(!manuallyRequested && {
            thresholdPercent,
            thresholdTokens: Math.floor(
              (thresholdPercent / 100) * contextWindow,
            ),
          }),
        },
      },
    );

    const result = await compact();
    if (result.didCompact) {
      this.pendingClientCompaction = {
        sourceMessages: messages,
        sourceFingerprint: this.messagesTailFingerprint(messages),
        result,
      };
    }
    return result;
  }

  /**
   * Shared scaffold for client-side conversation compaction (system-prompt-swap
   * summarization). Owns the provider-agnostic parts: separating leading
   * system/developer messages, the too-short guard, assembling the compacted
   * history, success/failure logging, and the error fallback.
   *
   * The provider supplies {@link summarize} (encode the supplied compaction
   * prompt, call the SDK, and return the summary text plus output-token count)
   * and {@link buildSummaryMessage} (encode the already-prefixed summary as a
   * provider message).
   *
   * Callers that keep their own post-compaction token bookkeeping (like
   * `ModelHandlerOpenAIResponse`'s client-side path) derive it from the returned
   * `compactedMessages` — the INPUT cost of the resent payload — rather than the
   * summarization call's output-token count, which measures a different thing.
   */
  protected async runClientCompaction(
    messages: M[],
    tokensBefore: number,
    summarize: (
      conversationMessages: M[],
      systemPrompt: string,
    ) => Promise<{ summaryText: string; outputTokens: number }>,
    buildSummaryMessage: (summary: string) => M,
  ): Promise<ClientCompactionResult<M>> {
    const contextWindow = this.getEffectiveContextWindow();

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

    const activity = startCompactionActivity(this.logger);
    try {
      const { summaryText, outputTokens } = await summarize(
        conversationMessages,
        COMPACTION_SYSTEM_PROMPT,
      );
      if (!summaryText) {
        this.logger.warn('Compaction returned empty summary, skipping');
        activity.finish('skipped');
        return { compactedMessages: messages, didCompact: false };
      }

      const compactedMessages: M[] = [
        ...systemMessages,
        buildSummaryMessage(`${COMPACTION_SUMMARY_PREFIX}${summaryText}`),
      ];

      logCompactionEvent({
        logger: this.logger,
        tokensBefore,
        // Rough post-compaction size for the log only; callers that need exact
        // bookkeeping recompute it from the resent payload's input cost.
        tokensAfter: Math.max(1, outputTokens),
        contextWindow,
        details: `Client-side compaction: ${conversationMessages.length} messages summarized`,
        tokensAfterIsEstimate: true,
      });

      activity.finish('completed');
      return {
        compactedMessages,
        didCompact: true,
      };
    } catch (err) {
      activity.finish(isUserAbort(err) ? 'cancelled' : 'failed');
      this.logger.warn(
        `Compaction failed, continuing with original messages: ${getSdkErrorMessage(err)}`,
        { data: err },
      );
      return { compactedMessages: messages, didCompact: false };
    }
  }

  /**
   * Sets up output file and resumes generation from any existing content.
   * @returns Promise resolving to [isComplete: generation complete, messages: updated message array]
   */
  async initializeOutputAndPrefill(
    _agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: M[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
  ): Promise<[boolean, M[]]> {
    if (!(await existsAndNonTrivial(outputLocation))) {
      return [false, messages];
    }

    const raw = await AbsoluteFS.read(outputLocation.absolutePath);
    const fileContent = this.postProcessResponse(raw);

    const scratchpad = await extractScratchpad(fileContent, 'scratchpad');
    if (scratchpad) this.logger.domain({ key: 'scratchpad', text: scratchpad });

    await AbsoluteFS.write(outputLocation.absolutePath, fileContent);

    // Updating workspace state is critical for multi-round agents on resume so
    // subsequent rounds have the correct context.
    workspaceState.assembly.accumulatedOutput = fileContent;
    workspaceState.assembly.lastResponse = fileContent;

    messages.push(this.createAssistantMessageForPrefillText(fileContent));

    if (hasEndTag(fileContent)) {
      this.logger.debug(
        'End tag detected - skipping model call (response already added above)',
      );
      return [true, messages];
    }

    this.logger.debug(
      'Output file exists but no end tag found - continuing from file',
    );

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
   * @returns Normalized usage, or undefined when the provider reports no usage
   */
  abstract normalizeUsage(
    rawUsage: U,
    responseTimeMs: number,
  ): NormalizedUsage | undefined;

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
    _responseObject?: Resp,
  ): void {
    const text = bestConnector + newResponse;
    const supportsPrefill = this.capabilities.supportsAssistantPrefill;

    if (
      this.appendTextToLastAssistantMessage(messages, text, {
        afterContinuationPrompt: !supportsPrefill,
        fallbackText: workspaceState.assembly.accumulatedOutput,
      })
    ) {
      return;
    }

    if (supportsPrefill) {
      messages.push(this.createAssistantMessageForPrefillText(text));
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
    _agentSetting: AgentSetting,
  ): boolean {
    const hasResponseEndTag = hasEndTag(newResponse);
    const shouldContinue =
      isTokenLimitStopReason(stopReason) && !hasResponseEndTag;

    this.logger.debug(
      shouldContinue
        ? `Should continue: token limit reached and end tag '${OUTPUT_END_TAG}' is missing.`
        : `Should not continue: StopReason='${stopReason}', HasEndTag='${hasResponseEndTag}'.`,
    );
    return shouldContinue;
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
    responseObject: Resp,
    workspaceState?: AgentWorkspaceState,
  ): string | null;

  /** Applies a single-string reasoning value to workspace thinking state.
   *  No-op when workspaceState is absent or thinking was already recorded. */
  protected applyStringReasoningToWorkspaceState(
    reasoning: string,
    workspaceState?: AgentWorkspaceState,
  ): void {
    if (
      workspaceState &&
      workspaceState.reasoning.thinkingBlocks.length === 0
    ) {
      workspaceState.reasoning.thinkingBlocks = [
        { type: 'thinking', thinking: reasoning },
      ];
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
  ): Promise<MediaAttachmentKind[]>;

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
      const error = new Error(
        `Token count of message exceeds context window: ${inputTokens} > ${contextWindow}`,
      );
      // Tag with a typed marker so isContextWindowError() recognizes this
      // internal case without depending on the message wording above, which
      // this method (not a third-party provider) owns and may reword freely.
      attachContextWindowError(error);
      throw error;
    }

    const utilizationPercent = roundedUtilizationPercent(
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
        this.logMaxTokensReduced({
          tokensBefore: inputTokens,
          contextWindow,
          utilizationPercent: validation.utilizationPercent,
          originalMaxTokens: currentMaxTokens,
          reducedMaxTokens: validation.adjustedMaxTokens,
          details: detailLabel,
        });
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
   * Emits the `max_tokens_reduced` context-management event.
   *
   * Both routes that shrink the output budget — the native token-count path in
   * {@link applyTokenCountLimit} and the estimate-based fallback handlers use
   * when counting is unavailable — report the same event, so its wording and
   * payload have one owner here.
   *
   * @param params.tokensBeforeIsEstimate Whether `tokensBefore` came from an
   *   estimate rather than a provider token count (changes the log wording).
   * @param params.utilizationPercent Utilization already computed by
   *   {@link validateTokenLimits}; recomputed here when absent.
   */
  protected logMaxTokensReduced(params: {
    tokensBefore: number;
    tokensBeforeIsEstimate?: boolean;
    contextWindow: number;
    utilizationPercent?: number;
    originalMaxTokens: number;
    reducedMaxTokens: number;
    details: string;
  }): void {
    const {
      tokensBefore,
      tokensBeforeIsEstimate = false,
      contextWindow,
      utilizationPercent,
      originalMaxTokens,
      reducedMaxTokens,
      details,
    } = params;
    const countLabel = tokensBeforeIsEstimate
      ? 'Estimated token count'
      : 'Token count';

    logContextManagementEvent(
      this.logger,
      `${countLabel} (${tokensBefore}) + max output tokens (${originalMaxTokens}) exceeds context window (${contextWindow}). Reducing to ${reducedMaxTokens}.`,
      {
        action: 'max_tokens_reduced',
        tokensBefore,
        contextWindow,
        utilizationBefore:
          utilizationPercent ??
          roundedUtilizationPercent(tokensBefore, contextWindow),
        originalMaxTokens,
        reducedMaxTokens,
        details,
      },
    );
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
   *
   * Defaults to the llm-zoo `supportsTokenCounting` capability flag (#7101:
   * pure-data predicate, read from the profile rather than overridden per
   * handler). Override only when the effective value comes from somewhere
   * other than `this.capabilities` — e.g. a provider-specific capabilities
   * lookup, or a hardcoded value where the API is universally available
   * regardless of the model's llm-zoo flag.
   */
  get supportsTokenCounting(): boolean {
    return this.capabilities.supportsTokenCounting;
  }

  /**
   * Release any resources held by the handler.
   * Override in subclasses that hold long-lived resources (e.g., WebSocket connections).
   */
  dispose(): void {
    // No-op by default
  }
}
