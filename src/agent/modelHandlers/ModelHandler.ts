// Node imports
import { createHash } from 'node:crypto';

// Third-party imports
import {
  ModelProvider,
  type ModelCapabilities,
  ReasoningEffort,
} from 'llm-zoo';
// Local imports
import type { AgentTrace, StreamHandle } from '@agent/trace';
import {
  attachChannelSubscriber,
  logContextManagementEvent,
  startCompactionActivity,
  TraceEmitter,
} from '@agent/trace';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { MediaEntry } from '@agent/types/mediaTypes';
import type { StandardPricingConfig } from '@agent/modelHandlers/support/priceUtils';
import { K_SLICE } from '@agent/core/constants';
import { isTokenLimitStopReason } from '@agent/types/StopReasonTypes';
import type { ProviderStopReason } from '@agent/types/StopReasonTypes';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractNormalizedResponseResult,
  ExtractResponseResult,
  ModelCredentialRoute,
  ModelCredentialSelection,
  ResolvedClientCredential,
  SdkToolCall,
  TokenCountOptions,
  TokenValidationResult,
} from '@agent/types/ModelHandlerContracts';
import { createNeutralResponseTextProcessing } from '@agent/runtime/responseTextProcessing';
import type { ServerToolExtractionResult } from '@agent/types/ServerTools';
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SYSTEM_PROMPT,
  logCompactionEvent,
} from '@agent/runtime/run/compaction';
import {
  attachContextWindowError,
  attachMissingApiKeyError,
} from '@common/errors/sdkError/errorMetadata';
import {
  isContextWindowError,
  isUserAbort,
} from '@common/errors/sdkError/errorPatterns';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { attachSdkCredentialRoute } from '@common/errors/sdkError/sdkRequestEndpoint';
import type { ResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { supportsReasoningLevel } from '@model/reasoningLevel';
import {
  resolveDirectModelApiKeyProvider,
  type ResolvedModelConfig,
} from '@model/openRouterRouting';
import { exposeApiKey, getApiKey, type ApiProvider } from '@model/apiProviders';
import { platform } from '@platform/platform';
import { longRunningModelFetch } from '@platform/defaults/longRunningModelTransport';
import type {
  FileLocation,
  MediaAttachmentKind,
  NormalizedUsage,
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas';
import {
  AgentCategory,
  MESSAGE_TYPES,
  OUTPUT_END_TAG,
  SCRATCHPAD_TAG,
} from '@shared/schemas';
import {
  MODEL_COMPACTION_THRESHOLD_SETTING,
  ModelCompactionThresholdPercentSchema,
} from '@shared/schemas';
import { roundedUtilizationPercent } from '@shared/runs/contextUtilization';
import { isObject } from '@utils/core';
import { isImageMimeType } from '@utils/files/mimeUtils';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { extractScratchpad } from '@utils/text/xmlExtraction';
import { getGlobalStreaming } from '@utils/config/providerConfig';
import { getValidatedConfig } from '@utils/config/configUtils';

// Local file imports
import {
  computeReducedMaxTokens,
  TOKEN_SAFETY_BUFFER,
  TOOL_USE_SAFETY_BUFFER,
  TOOL_USE_MAX_OUTPUT_FACTOR,
} from './contextManagementConstants';
import { MediaAttachmentProcessor } from './support/MediaAttachmentProcessor';
import {
  reportMediaAttachmentFailure,
  type MediaAttachmentContext,
} from './support/mediaAttachmentPolicy';
import {
  resolveProxyEndpoint,
  shouldUseOpenRouter,
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

/**
 * A round's media content plus the entries behind it — what the transcript's
 * attachment chips are derived from. Returned together so the two can't drift.
 */
export interface CreatedMedia<Media> {
  readonly media: Media[];
  readonly entries: readonly MediaEntry[];
}

/**
 * Options for {@link ModelHandler.appendTextToLastAssistantMessage}. Exported
 * as the single source of truth for the append-options contract so provider
 * overrides reference this shape by name instead of redeclaring it inline (two
 * of them had already drifted, silently dropping `fallbackText`).
 */
export interface AssistantTextAppendOptions {
  /**
   * True when the current trailing user/system message may be the synthetic
   * continuation prompt. Providers decide whether to append to the previous
   * assistant turn and whether the trailing prompt should be removed.
   */
  readonly afterContinuationPrompt?: boolean;
  /** Provider fallback when converting an existing assistant message shape. */
  readonly fallbackText?: string;
}

function mediaAttachmentKindsFromEntries(
  entries: readonly MediaEntry[],
): MediaAttachmentKind[] {
  return entries.map((entry) =>
    entry.media_category === 'image' && isImageMimeType(entry.media_type)
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
    // Initialize with default channel, will be overwritten by agent. Log-only
    // module singletons now use `createLog`; remaining `createChannelTrace`
    // sites are genuine `AgentTrace`-typed fallbacks plus log-only callers
    // (singletons, per-instance defaults, inline one-offs) still being
    // narrowed under #10595. Unlike those, this default is exercised through
    // `createThinkingStream`/`createOutputStream` (`this.logger.openRun(...)`)
    // before `setLogger` swaps in the real per-run trace in some paths, so it
    // needs the full `TraceEmitter`, not a log-only closure.
    this.logger = new TraceEmitter();
    attachChannelSubscriber(this.logger, 'Agent');
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
    return this.logger.openRun(MESSAGE_TYPES.THINKING, {
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
    return this.logger.openRun(MESSAGE_TYPES.MODEL_RESPONSE, {
      progressViewEnabled: this.progressViewEnabled,
      deferStart: !options?.atPhaseSignal,
      phaseOnly: !this.outputStreaming,
    });
  }

  /**
   * Success-path close of the thinking/output stream pair opened via
   * {@link createThinkingStream}/{@link createOutputStream}: the thinking
   * stream closes with the processed thinking block, then the output stream
   * closes with the provider-extracted final text. Each provider keeps
   * extracting that text itself (every response shape reads differently);
   * what shares is the finalize ordering.
   *
   * `extractFinalText` is a callback (not a precomputed string) so extraction
   * runs AFTER `processThinkingBlock` has committed the processed reasoning:
   * if extraction throws, the thinking stream keeps the processed reasoning
   * (`finalize` is idempotent) instead of falling back to the raw streamed
   * chunks via the error path (#10372).
   */
  protected finalizeProgressRuns(
    thinking: StreamHandle,
    output: StreamHandle,
    response: Resp,
    extractFinalText: () => string,
  ): void {
    const finalReasoning = this.processThinkingBlock(response);
    thinking.finalize(finalReasoning ?? undefined);
    output.finalize(extractFinalText());
  }

  /**
   * Error-path close of the thinking/output stream pair so the progress view
   * does not hang in a loading state. No explicit final text, so chunks
   * already streamed are preserved (passing `''` would overwrite the visible
   * partial output). `finalize` is idempotent, so this is safe even after a
   * partial finalize already ran.
   */
  protected finalizeProgressRunsOnError(
    thinking: StreamHandle | undefined,
    output: StreamHandle | undefined,
  ): void {
    thinking?.finalize(undefined);
    output?.finalize();
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
      return exposeApiKey(await getApiKey(platform().secrets, provider));
    } catch (cause) {
      const error = new Error(errorMessage, { cause });
      attachMissingApiKeyError(error);
      throw error;
    }
  }

  /**
   * Resolve the credential and endpoint together for one client construction.
   * The returned value is immutable and no later request step needs to reread
   * the process-wide access settings. The base resolver serves direct API
   * keys and OpenRouter; subscription-capable handlers consult `selection`
   * in their own overrides (`personal` forces the direct key).
   */
  protected async resolveClientCredential(
    _selection: ModelCredentialSelection = 'configured',
  ): Promise<ResolvedClientCredential> {
    const useOpenRouter = shouldUseOpenRouter(this.config);
    const provider = useOpenRouter
      ? 'openRouter'
      : resolveDirectModelApiKeyProvider(this.config);
    if (!provider) {
      throw new Error(
        `Model "${this.config.name}" has no direct API-key provider.`,
      );
    }
    const apiKey = await this.fetchApiKeyOrThrow(
      provider,
      useOpenRouter
        ? `Missing OpenRouter API key. Set an OpenRouter API key in settings.`
        : `Missing API key for ${provider}. Set a provider API key in settings.`,
    );
    const endpoint = resolveProxyEndpoint(this.buildProxyConfig(useOpenRouter));
    return {
      apiKey,
      baseUrl: endpoint.baseUrl,
      route: useOpenRouter ? 'openrouter' : 'api-key',
      ...('usageRoute' in endpoint && { usageRoute: endpoint.usageRoute }),
    };
  }

  /**
   * Build the {@link ProxyConfig} route for the current config plus a
   * caller-resolved OpenRouter decision. A per-model custom base URL always
   * wins, matching `resolveProxyEndpoint`'s documented precedence.
   */
  private buildProxyConfig(useOpenRouter: boolean): ProxyConfig {
    if (this.config.baseUrl) {
      return {
        route: 'custom',
        provider: this.config.provider,
        url: this.config.baseUrl,
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
    // Subscription routes have stable route identities so ordinary token
    // rotation does not split recovery coordination; direct credentials
    // use a non-secret fingerprint so distinct keys stay distinct routes.
    const credentialIdentity =
      route === 'chatgpt-subscription' || route === 'xai-subscription'
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
    return isObject(client)
      ? this.clientWireIdentities.get(client)?.route
      : undefined;
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

  /**
   * Retrieves base URL for API requests based on provider and OpenRouter configuration.
   * @returns Base URL string or null for providers using default URLs
   */
  public getBaseUrl(): string | null {
    const activeRoute = this.activeAttemptCredentialRoute;
    // Use centralized check to ensure consistency with client construction
    // Pass the decision along to avoid duplicate checks
    const useOpenRouter =
      activeRoute !== undefined
        ? activeRoute === 'openrouter'
        : shouldUseOpenRouter(this.config);
    return resolveProxyEndpoint(this.buildProxyConfig(useOpenRouter)).baseUrl;
  }

  /** Stable endpoint identity used to coordinate retries for one client. */
  public getRetryEndpoint(_client: C): string {
    return this.getBaseUrl() ?? `${this.config.provider}:default`;
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
    return supportsReasoningLevel(this.config);
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

  /**
   * Prompt-token total from the most recent API response, for handlers whose
   * client-side compaction trigger keys off API-reported usage. Fed by
   * {@link trackLastKnownInputTokens}; read by
   * {@link maybeCompactByLastKnownInputTokens} and by the handlers'
   * `compactConversation` as the `tokensBefore` figure. Handlers with
   * server-side chain state key off the chain's cumulative count instead.
   */
  protected lastKnownInputTokens = 0;

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

  /** Whether requests stream: one global toggle covers every provider. */
  public getStreamingConfig(): boolean {
    return getGlobalStreaming();
  }

  /**
   * Normalizes a reasoning-effort value for the concrete handler.
   * Provider handlers override this hook when their API supports a narrower
   * vocabulary.
   */
  protected validateReasoningEffort(effort: string): string {
    return effort;
  }

  /** Returns the effective reasoning effort for the current user and model. */
  protected getEffectiveReasoningEffort(): ReasoningEffort | null {
    const { supportsReasoningEffort, reasoningEffort } = this.capabilities;
    if (!supportsReasoningEffort || !reasoningEffort) {
      return null;
    }

    // NONE stays a value, not a null: it is a deliberate user choice
    // ("minimize reasoning") that providers map to their minimum effort level
    // (e.g. Anthropic → 'low'), while null would fall back to default effort.
    return reasoningEffort;
  }

  /**
   * Create image/audio messages for the conversation.
   * This is a shared implementation that can be used by all providers.
   * Individual providers can override if needed.
   * @returns The provider-specific media content and the entries behind it
   */
  protected async createMediaMessage(
    mediaFiles: FileLocation[],
    _context: MediaAttachmentContext,
  ): Promise<CreatedMedia<Media>> {
    const { entries, results } =
      await this.mediaProcessor.loadEntries(mediaFiles);
    this.mediaProcessor.logResults(results);
    // Reports every loaded entry, including any `createMediaContent` drops.
    return { media: this.createMediaContent(entries), entries };
  }

  public consumeInsertedAttachmentKinds(
    context: MediaAttachmentContext,
  ): MediaAttachmentKind[] {
    const kinds = this.insertedAttachmentKinds.get(context) ?? [];
    this.insertedAttachmentKinds.set(context, []);
    return kinds;
  }

  /**
   * Single call-through for building a round's media content (#7465): every
   * provider's `initializeMessages` override calls this instead of wrapping
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
    try {
      const { media, entries } = await this.createMediaMessage(
        mediaFiles,
        context,
      );
      if (media.length > 0) {
        this.insertedAttachmentKinds.set(
          context,
          mediaAttachmentKindsFromEntries(entries),
        );
      }
      return media;
    } catch (err) {
      reportMediaAttachmentFailure(this.logger, context, err);
      return [];
    }
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
   * Attach the endpoint a thrown SDK error was sent to, when the client can
   * report it. Runs at the same boundary as {@link sdkErrorTagger}; provider
   * subclasses override it to stamp a request config so downstream error
   * detection that keys off the wire endpoint (e.g. Kimi Code subscription
   * usage limits) can see it even though the raw SDK error does not carry one.
   * Defaults to a no-op for handlers whose clients don't expose a base URL.
   */
  protected attachSdkRequestEndpoint(_err: unknown, _client: C): void {}

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
    const identity = isObject(options.client)
      ? this.clientWireIdentities.get(options.client)
      : undefined;
    const credentialRoute = identity?.route;
    return this.withCreateResponseGuard(async () => {
      this.activeAttemptCredentialRoute = credentialRoute;
      this.lastAttemptCredentialRoute = credentialRoute;
      this.lastAttemptUsageRoute = identity?.usageRoute;
      try {
        return await this.createResponseImpl(options);
      } catch (err) {
        this.sdkErrorTagger(err, this.config.provider);
        this.attachSdkRequestEndpoint(err, options.client);
        if (credentialRoute !== undefined) {
          attachSdkCredentialRoute(err, credentialRoute);
        }
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
   * Configured client-side compaction threshold, as a percentage of the context
   * window. Returns 0 when compaction is disabled.
   */
  protected getCompactionThresholdPercent(): number {
    // Validated, like the sibling `model.retry.maxAttempts` reader: the
    // settings row resolves this key through the same schema, so an
    // out-of-range hand-edited value must not leave the row showing the
    // default while this reader silently honors the invalid number.
    return getValidatedConfig(
      MODEL_COMPACTION_THRESHOLD_SETTING.configKey,
      ModelCompactionThresholdPercentSchema,
      MODEL_COMPACTION_THRESHOLD_SETTING.defaultValue,
    );
  }

  /**
   * Runs input-token-driven compaction when the shared threshold policy selects
   * the current conversation. Compaction triggers only in tool-use mode, on a
   * manual request, or when `inputTokens` exceeds the configured percentage of
   * the context window. The trigger, request consumption, and diagnostic
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

    if (!this.isToolUseMode()) {
      return { compactedMessages: messages, didCompact: false };
    }
    const manuallyRequested = this.consumeCompactionRequest();
    const thresholdPercent = this.getCompactionThresholdPercent();
    const contextWindow = this.getEffectiveContextWindow();
    const exceedsThreshold =
      thresholdPercent > 0 &&
      inputTokens > Math.floor((thresholdPercent / 100) * contextWindow);
    if (!manuallyRequested && !exceedsThreshold) {
      return { compactedMessages: messages, didCompact: false };
    }

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
   * COMPACT-phase prologue for handlers that compact client-side off the last
   * API-reported prompt-token count: run the shared threshold trigger
   * ({@link maybeCompactByInputTokens}) against {@link lastKnownInputTokens}
   * and reshape the result into the {@link CreateResponseResult.updatedMessages}
   * contract — `undefined` unless this call actually compacted. The provider
   * supplies only its SDK-specific summarization call via {@link compact}.
   */
  protected async maybeCompactByLastKnownInputTokens(
    messages: M[],
    compact: () => Promise<ClientCompactionResult<M>>,
  ): Promise<{ messagesToUse: M[]; updatedMessages: M[] | undefined }> {
    const { compactedMessages, didCompact } =
      await this.maybeCompactByInputTokens(
        messages,
        this.lastKnownInputTokens,
        compact,
      );
    const updatedMessages = didCompact ? compactedMessages : undefined;
    return { messagesToUse: updatedMessages ?? messages, updatedMessages };
  }

  /**
   * TRACK-phase companion to {@link maybeCompactByLastKnownInputTokens}:
   * record the prompt-token total from a completed response. Reports whether
   * a total was present so the handler keeps its own missing-usage
   * diagnostics.
   */
  protected trackLastKnownInputTokens(
    promptTokens: number | null | undefined,
  ): boolean {
    if (!promptTokens) return false;
    this.lastKnownInputTokens = promptTokens;
    return true;
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
      messages.push(this.createAssistantMessage(text));
      return;
    }

    messages.push(
      this.createAssistantMessageForAccumulatedOutput(workspaceState),
    );
  }

  /** Provider hook for fresh assistant turns after a no-prefill response. */
  protected createAssistantMessageForAccumulatedOutput(
    workspaceState: AgentWorkspaceState,
  ): M {
    return this.createAssistantMessage(
      workspaceState.assembly.accumulatedOutput,
    );
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
   * Extract assistant content blocks from a response, excluding tool_use blocks.
   * Default implementation returns empty array for providers without this concept.
   * Override in handlers that support structured content blocks (e.g., Anthropic).
   */
  extractAssistantContent(_responseObject: Resp): unknown[] {
    return [];
  }

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

    const adjustedMaxTokens =
      availableTokens >= maxTokens
        ? maxTokens
        : computeReducedMaxTokens(availableTokens, tokenBuffer);

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
