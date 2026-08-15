// Third-party imports
import {
  GoogleGenAI,
  PartMediaResolutionLevel,
  createPartFromBase64,
  createPartFromText,
  createPartFromUri,
  createUserContent,
  type Interactions,
  type Part,
  type Stream,
} from '@google/genai';
import { ReasoningEffort } from 'llm-zoo';

// Local imports
import { logProgressStatus } from '@agent/trace';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import { reportMediaAttachmentFailure } from '@agent/modelHandlers/support/mediaAttachmentPolicy';
import { parseToolInputAsObject } from '@agent/core/flows/toolUseRound/toolCallParsing';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { K_SLICE } from '@agent/core/constants';
import { GOOGLE_FINISH } from '@agent/types/StopReasonTypes';
import type { ProviderStopReason } from '@agent/types/StopReasonTypes';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  GoogleToolCall,
  ModelCredentialSelection,
  TokenCountOptions,
} from '@agent/types/ModelHandlerContracts';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import { detectStatusCode } from '@common/errors/sdkError/errorInspection';
import {
  attachManualRetryOnlyError,
  attachPartialText,
} from '@common/errors/sdkError/errorMetadata';
import {
  PARTIAL_TEXT_TAIL_MAX,
  takeTail,
} from '@common/errors/sdkError/errorPatterns';
import type { ToolDefinition } from '@model/ToolDefinition';
import { composeLongRunningModelDispatcher } from '@platform/defaults/longRunningModelTransport';
import type {
  FileLocation,
  MediaAttachmentKind,
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas';
import { filterNotNull, generateShortId, isNonEmptyString } from '@utils/core';
import { getShortDisplayPath } from '@utils/files/fileLocation';
import { joinNonEmpty, pluralize } from '@utils/text/stringUtils';
import { getConfig } from '@utils/config/configUtils';

// Local file imports
import {
  resolveGoogleClient,
  uploadGoogleMediaEntries,
  type GoogleClientCache,
  type GoogleMediaSource,
} from './googleHandlerShared';
import { tagGoogleSdkError } from './googleSdkError';
import {
  computeGoogleInteractionsPrice,
  normalizeGoogleInteractionsUsage,
} from './googleInteractionsUsage';
import {
  BackgroundRunLifecycle,
  type BackgroundRetrieveFailureVerdict,
  type BackgroundTerminalVerdict,
} from '../support/BackgroundRunLifecycle';
import { ServerChainState } from '../support/ServerChainState';
import { CLIENT_COMPACTION_SUMMARY_MAX_TOKENS } from '../contextManagementConstants';
import {
  DEFAULT_ATTACHMENT_MIME_TYPE,
  formatAttachmentSummary,
  formatToolResultAsText,
  loadAttachmentBuffer,
} from '../utils/toolAttachmentUtils';
import { convertGoogleToolSchema, toGoogleTools } from '../toolConversion';
import type { BackgroundPollStats } from '../support/BackgroundPoller';

// Interactions SDK aliases (public surface; the SDK re-exports these under the
// `Interactions` namespace — the internal `_2`-suffixed types are not exported).
type Step = Interactions.Step;
type Content = Interactions.Content;
type TextContent = Interactions.TextContent;
type ImageContent = Interactions.ImageContent;
type AudioContent = Interactions.AudioContent;
type DocumentContent = Interactions.DocumentContent;
type VideoContent = Interactions.VideoContent;
type UserInputStep = Interactions.UserInputStep;
type ModelOutputStep = Interactions.ModelOutputStep;
type ThoughtStep = Interactions.ThoughtStep;
type FunctionCallStep = Interactions.FunctionCallStep;
type FunctionResultStep = Interactions.FunctionResultStep;
type FunctionResultSubcontent = TextContent | ImageContent;
type FunctionT = Interactions.Function;
type Usage = Interactions.Usage;
type GenerationConfig = Interactions.GenerationConfig;
type ThinkingLevel = Interactions.ThinkingLevel;
type MediaResolution = NonNullable<ImageContent['resolution']>;
type InteractionSSEEvent = Interactions.InteractionSSEEvent;
type CreateModelInteractionParamsStreaming =
  Interactions.CreateModelInteractionParamsStreaming;
type CreateModelInteractionParamsNonStreaming =
  Interactions.CreateModelInteractionParamsNonStreaming;
// `InteractionStatus` is internal (not re-exported under the `Interactions`
// namespace), so derive it from the public `Interaction.status` field instead of
// referencing the unexported alias. Union (genai.d.ts): 'queued' |
// 'in_progress' | 'requires_action' | 'completed' | 'failed' | 'cancelled' |
// 'incomplete' | 'budget_exceeded' | (string & {}).
type InteractionStatus = Interactions.Interaction['status'];
// The non-streaming get param type is `Omit<GetInteractionByIdRequest,'id'> &
// { stream?: false }` — the `id` is the positional first arg, so it is NOT
// repeated in the params object (verified against genai.d.ts get() overload).
type InteractionGetParamsNonStreaming =
  Interactions.InteractionGetParamsNonStreaming;
// The SDK's own `GoogleGenAIInteraction` (the wrapped non-streaming response)
// is an internal `declare type` and is NOT re-exported, so we reconstruct its
// public shape: the `Interaction` body with `steps` made non-optional (the SDK
// override). The handler only reads `status`/`usage`/`steps`, which both the
// non-streaming response and the SSE `interaction.completed` event expose.
type GoogleGenAIInteraction = Omit<Interactions.Interaction, 'steps'> & {
  steps?: Step[];
};

/**
 * Maps an Interactions media `resolution` literal to the chat
 * `PartMediaResolutionLevel` used by the countTokens estimate. Unknown values
 * (including the SDK's open `(string & {})` member) fall through to `undefined`.
 */
const COUNTABLE_MEDIA_RESOLUTION_BY_LEVEL: Partial<
  Record<string, PartMediaResolutionLevel>
> = {
  low: PartMediaResolutionLevel.MEDIA_RESOLUTION_LOW,
  medium: PartMediaResolutionLevel.MEDIA_RESOLUTION_MEDIUM,
  high: PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH,
};

/**
 * Type guard for Interactions text content blocks.
 *
 * (Steps use the typed `Content` union instead of chat `Part`s, so the chat
 * handler's `isTextPart` does not apply — see spec §4.3.)
 */
function isTextContent(content: Content): content is TextContent {
  return content.type === 'text';
}

/** Remove text blocks that the Interactions API rejects as missing content. */
function omitEmptyTextContent<T extends Content>(content: readonly T[]): T[] {
  return content.filter(
    (item) => !isTextContent(item) || Boolean(item.text?.trim()),
  );
}

/**
 * Normalize text-bearing steps at the external API boundary. This also covers
 * transcripts restored from storage before this invariant was introduced.
 */
function omitEmptyTextContentFromSteps(steps: readonly Step[]): Step[] {
  return steps.map((step) => {
    if (step.type === 'user_input' || step.type === 'model_output') {
      return {
        ...step,
        content: omitEmptyTextContent(step.content ?? []),
      } satisfies UserInputStep | ModelOutputStep;
    }
    if (step.type === 'thought' && step.summary) {
      return {
        ...step,
        summary: omitEmptyTextContent(step.summary),
      } satisfies ThoughtStep;
    }
    if (step.type === 'function_result' && Array.isArray(step.result)) {
      return {
        ...step,
        result: omitEmptyTextContent(step.result),
      } satisfies FunctionResultStep;
    }
    return step;
  });
}

/**
 * Steps the CLIENT contributes and must (re)send: the user's turns and tool
 * results. Under `previous_interaction_id` chaining the model-generated steps
 * (thought / function_call / model_output) are already held by the server, so
 * only these are sent in the delta. (Verified live: echoing a server-held
 * function_call on a chained tool round → HTTP 400; function_result-only → ok.)
 */
function isClientInputStep(step: Step): boolean {
  return step.type === 'user_input' || step.type === 'function_result';
}

/** Concatenate the text of every TextContent block in a content list. */
function joinTextContent(content: readonly Content[]): string {
  return content
    .filter(isTextContent)
    .map((c) => c.text)
    .join('');
}

/** Extract raw model text without user-facing LaTeX post-processing. */
function rawModelOutputText(interaction: GoogleGenAIInteraction): string {
  return (interaction.steps ?? [])
    .filter((step): step is ModelOutputStep => step.type === 'model_output')
    .map((step) => joinTextContent(step.content ?? []))
    .join('');
}

/** Best-effort extraction of an SDK error's human-readable message. */
function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown })?.message;
  return typeof message === 'string' ? message : '';
}

/**
 * Best-effort predicate for "the `previous_interaction_id` we chained onto is
 * gone (expired / unknown / rejected)". On a match the handler drops the chain
 * and full-resends once. Kept permissive-but-anchored so it never swallows an
 * unrelated 404 — a generic status match must be corroborated by interaction /
 * previous_interaction_id wording in the message.
 *
 * SMOKE-TEST: the exact HTTP status / error.code / message string the Google
 * Interactions backend returns for an expired or unknown previous_interaction_id
 * is UNCONFIRMED from genai.d.ts (ErrorT exposes only `code?`/`message?`, and
 * InteractionStatus has no `expired` member). Tune to the observed shape after a
 * real-key run (spec §6 S2). The full-resend retry is idempotent regardless.
 */
function isStaleInteractionChainError(error: unknown): boolean {
  const status = detectStatusCode(error);
  const message = errorMessageOf(error);
  const rawCode = (error as { code?: unknown })?.code;
  const code = typeof rawCode === 'string' ? rawCode : '';

  const mentionsPreviousInteractionId = /previous_interaction_id/i.test(
    message,
  );
  // Anchor: interaction-chain wording in the message.
  const mentionsInteractionChain =
    /\binteraction\b[\s\S]*\b(not\s*found|expired|invalid|unknown|does not exist)\b/i.test(
      message,
    );

  const staleStatus = status === 404 || status === 410;
  const staleCode = [
    'NOT_FOUND',
    'INVALID_ARGUMENT',
    'FAILED_PRECONDITION',
  ].includes(code);

  // Explicit previous_interaction_id wording alone is sufficient; a bare
  // status/code match qualifies only when corroborated by interaction-chain
  // wording (so an unrelated 404 is never eaten).
  return (
    mentionsPreviousInteractionId ||
    ((staleStatus || staleCode) && mentionsInteractionChain)
  );
}

/**
 * True when the model rejected `background:true` because it does not support
 * background interactions (verified live: gemini-2.5-flash → HTTP 400
 * "Model '…' does not support background interactions."). Anchored on the
 * "background" + "support" wording so it never misclassifies an unrelated 400.
 */
function isBackgroundUnsupportedError(error: unknown): boolean {
  const message = errorMessageOf(error).toLowerCase();
  return (
    message.includes('background') &&
    (message.includes('not support') ||
      message.includes('unsupported') ||
      message.includes("doesn't support"))
  );
}

/**
 * Raw accumulator for a single in-flight step during streaming.
 *
 * This buffers delta fragments ONLY — it carries no discriminant `type` tag.
 * Earlier versions mutated a `.type` field as different SSE delta kinds
 * arrived (`'model_output'` / `'thought'` / `'function_call'`), which made the
 * final kind depend on mutation order rather than on the data actually
 * accumulated. `finalizeSteps` now derives the kind once, from which of these
 * fields are populated (see the precedence comment there).
 */
interface PendingStepBuffer {
  /** model_output text accumulator */
  text?: string;
  /** thought summary accumulator */
  thought?: string;
  /** thought signature, captured from ThoughtSignatureDelta */
  signature?: string;
  /** function_call id/name, seeded from a function_call step.start event */
  callId?: string;
  callName?: string;
  /** concatenated arguments_delta fragments, parsed at step.stop */
  argsBuffer?: string;
  /** parsed arguments after step.stop */
  args?: Record<string, unknown>;
}

/**
 * Handler for Google models using the @google/genai Interactions API.
 *
 * The direct Google handler. Google models routed through OpenRouter use the
 * OpenRouter handler instead.
 *
 * STATEFUL by default (`store: true`): server-side conversation state via
 * `previous_interaction_id` chaining — each round sends only the Steps appended
 * since the last completed turn and chains onto the prior interaction, so Google
 * holds the history. Controlled by `texra.model.useGoogleInteractionsServerState`
 * (default true). When that flag is OFF the handler falls back to STATELESS mode
 * (`store: false`): the full `Step[]` transcript is resent every round with no
 * `previous_interaction_id`. Either way, request-level `system_instruction` /
 * `tools` / `generation_config` are sent on every `create`, and the model's
 * generated Steps (thought signatures + function calls) are appended to the
 * local transcript verbatim — in stateless mode they are resent; in chained mode
 * the server retains them and only the new turn is sent (see
 * {@link buildAssistantTurnSteps}, spec §6.1-§6.2). Chaining state lives on the
 * instance ({@link finalizeChain} / {@link ServerChainState.invalidateChain});
 * a restored run or model switch gets a fresh instance and safely full-resends,
 * never reusing a stale interaction id.
 *
 * Known limitation: a TERMINAL turn (model emits text with no tool call) is
 * recorded via the base `createAssistantMessageFromResponse`, which yields a
 * text-only `model_output` step — the trailing thought signature is not
 * preserved. Gemini only requires signatures within an in-flight
 * function-calling sequence, so this is safe; a fuller fix would need the base
 * contract to return `Step[]` (out of scope).
 */
/** Per-call options threaded to every Speakeasy Interactions request. */
type InteractionsRequestOptions = {
  maxRetries: number;
  fetchOptions: RequestInit;
};

export class ModelHandlerGoogleInteractions extends ModelHandler<
  Step,
  Usage | null,
  GoogleToolCall,
  GoogleGenAI,
  GoogleGenAIInteraction,
  Content
> {
  // ===========================================================================
  // BACKGROUND mode (background:true + store:true, poll interactions.get)
  // ===========================================================================
  //
  // Background submits a long-running interaction asynchronously and polls
  // interactions.get(id) until a terminal status, surfacing the completed
  // interaction through the same CreateResponseResult the streaming /
  // non-streaming paths return. Background REQUIRES server-side state
  // (store:true) — the only way to retrieve a long-running result is get(id),
  // which needs the interaction persisted — so it never activates in stateless
  // mode (see useBackgroundMode / executeBackgroundPath). Mirrors
  // ModelHandlerOpenAIResponse.

  protected override backgroundModeSupported = true;

  private static readonly BACKGROUND_GET_PARAMS: InteractionGetParamsNonStreaming =
    { stream: false };

  private static readonly BACKGROUND_MAX_DURATION_MS = 3 * 60 * 60 * 1000;

  /** Non-terminal statuses. `requires_action` remains serviceable terminal. */
  private static readonly BACKGROUND_PENDING_STATUSES: readonly InteractionStatus[] =
    ['queued', 'in_progress'];

  private static readonly BACKGROUND_FAILURE_STATUSES: readonly InteractionStatus[] =
    ['failed', 'cancelled', 'incomplete', 'budget_exceeded'];

  /**
   * Pending background-interaction id + resume/poll choreography, owned by the
   * shared provider-neutral {@link BackgroundRunLifecycle} (also used by the
   * OpenAI Responses handler). The hooks below carry every Google-specific
   * decision: the Interactions status vocabulary (`requires_action` is a
   * serviceable terminal), the stale-id predicate (deliberately
   * provider-specific — see the SMOKE-TEST note on
   * {@link isStaleInteractionChainError}), the manual-retry error factories,
   * and the best-effort server-side cancel (fire-and-forget on abort, awaited
   * on timeout).
   */
  private readonly backgroundLifecycle = new BackgroundRunLifecycle<
    GoogleGenAI,
    GoogleGenAIInteraction,
    InteractionGetParamsNonStreaming
  >({
    logger: () => this.logger,
    providerLabel: 'Google Interactions',
    resourceLabel: 'interaction',
    pollIntervalMs: 5000,
    maxDurationMs: ModelHandlerGoogleInteractions.BACKGROUND_MAX_DURATION_MS,
    isPendingStatus: (r) =>
      ModelHandlerGoogleInteractions.BACKGROUND_PENDING_STATUSES.includes(
        r.status as InteractionStatus,
      ),
    // `completed` and `requires_action` are both serviceable terminals: the
    // latter carries function_call steps, so return it (don't throw) and let
    // the cycle service the tools, mirroring the streaming/non-streaming paths
    // and finalizeChain's chain-safe handling. Workflow agents normally carry
    // no tools, but the gate (isWorkflowMode) is not a hard guarantee, so
    // handle it rather than crash a run that does emit a call.
    isServiceableStatus: (r) =>
      r.status === 'completed' || r.status === 'requires_action',
    extractId: (r) => r.id,
    extractStatus: (r) => r.status ?? 'unknown',
    retrieve: (client, interactionId, _retrieveParams, signal) =>
      client.interactions.get(
        interactionId,
        ModelHandlerGoogleInteractions.BACKGROUND_GET_PARAMS,
        this.interactionsRequestOptions(signal),
      ),
    tagSdkError: (error) => this.sdkErrorTagger(error, this.config.provider),
    onResumeRetrieveError: (error, interactionId) =>
      this.classifyBackgroundRetrieveFailure(error, interactionId),
    onPollRetrieveError: (error, interactionId) =>
      this.classifyBackgroundRetrieveFailure(error, interactionId),
    createTimeoutError: (interactionId) =>
      this.createBackgroundTimeoutError(interactionId),
    // A resumed interaction — completed, requires_action, failed, or unknown —
    // always routes through the poll driver so its terminal handling (and
    // logs) is identical to a fresh submission's.
    onResumedSettled: () => ({ action: 'poll' }),
    clearOnServiceableTerminal: true,
    createTerminalVerdict: (polled, interactionId, stats) =>
      this.backgroundTerminalVerdict(polled, interactionId, stats),
    extraFinishData: (interaction) => ({
      usage: interaction.usage ?? undefined,
    }),
    onAbortDiscard: (client, interactionId) => {
      // Fire-and-forget cancel; never awaited so abort propagation is instant.
      void this.cancelBackgroundInteraction(client, interactionId);
    },
    onTimeoutDiscard: (client, interactionId) =>
      this.cancelBackgroundInteraction(client, interactionId),
  });

  /**
   * Set true after the model rejects `background:true` (HTTP 400 "does not
   * support background interactions"). Sticky for the instance: once a model
   * proves it cannot run background, the handler falls back to the streaming /
   * non-streaming path for the rest of the run. Not all Interactions-capable
   * Gemini models support background (verified live: gemini-2.5-flash 400s,
   * gemini-3.5-flash works), and there is no registry capability flag for it, so
   * this runtime fallback is the model gate.
   */
  private backgroundUnsupported = false;

  // ===========================================================================
  // STATEFUL chaining state (store:true + previous_interaction_id)
  // ===========================================================================
  //
  // This state lives on the handler INSTANCE — not on workspaceState, Step[],
  // or any snapshot — because the handler is created once per run and reused
  // across rounds. A restored run (resume / model-switch) constructs a FRESH
  // instance whose chain anchor is null, which naturally starts a full
  // resend, so a dead (possibly expired) interaction id is never referenced
  // cross-session. The anchor id (`previous_interaction_id` here,
  // `previous_response_id` on the OpenAI Responses handler), the sent-Step
  // count that anchors the delta slice, and the cumulative input-token count
  // that drives the compaction trigger are the same three facts on both
  // handlers, so they are owned by the shared {@link ServerChainState}; see
  // {@link finalizeChain} for the Google-specific capture rules.

  /** Chain anchor + sent-Step/token bookkeeping. See {@link ServerChainState}
   *  for the narrow interface this handler uses instead of mutating chain
   *  fields directly. */
  private readonly chainState = new ServerChainState();

  /** Whether server-side conversation state (store:true chaining) is enabled. */
  private serverStateEnabled(): boolean {
    return getConfig<boolean>(
      'texra.model.useGoogleInteractionsServerState',
      true,
    );
  }

  // ===========================================================================
  // BACKGROUND mode gate
  // ===========================================================================

  /**
   * Background mode is active when this handler supports it, server-side state is
   * enabled (store:true — required to retrieve the result via get(id)), the agent
   * is in workflow mode, and the user toggle is on. Background is categorically
   * impossible in stateless mode, so `stateful` is load-bearing (unlike OpenAI,
   * which always sends store:true). Workflow-only mirrors OpenAI's exclusion of
   * tool-use loops (which rely on per-step streaming). There is no Gemini
   * analogue of isGptFamilyModelName, and not every Interactions-capable model
   * supports background (gemini-2.5-flash 400s), so the per-model gate is the
   * runtime `backgroundUnsupported` fallback rather than a model-name check.
   */
  private useBackgroundMode(stateful: boolean): boolean {
    return (
      this.backgroundModeSupported &&
      !this.backgroundUnsupported &&
      stateful &&
      this.isWorkflowMode() &&
      getConfig<boolean>('texra.model.useBackgroundResponses', true)
    );
  }

  public override isBackgroundModeActive(): boolean {
    return (
      this.backgroundLifecycle.hasPendingResume() ||
      this.useBackgroundMode(this.serverStateEnabled())
    );
  }

  /**
   * Background replaces streaming (polling completed results is incompatible with
   * incremental SSE). When background is active, streaming is forced off so the
   * createResponseImpl dispatch resolves to the background branch. Mirrors
   * ModelHandlerOpenAIResponse.getStreamingConfig.
   */
  public override getStreamingConfig(): boolean {
    return !this.isBackgroundModeActive() && super.getStreamingConfig();
  }

  /**
   * Capture (or reject) the chain anchor after a response. Chain from a retained
   * interaction that carries a string id; otherwise invalidate so the next round
   * full-resends rather than chaining onto an interaction the server may not have
   * retained.
   *
   * Chain-safe statuses: `completed` (final answer) AND `requires_action`
   * (tool-call round — the model emitted function_call(s) and is awaiting
   * results; the interaction is retained and continuable via
   * `previous_interaction_id`). This mirrors the OpenAI Responses handler, whose
   * tool-call responses come back `completed`; Google surfaces the same point as
   * `requires_action`. Without this, tool-using agents would drop the chain
   * every round and never benefit from server-side state.
   *
   * The next round's delta is filtered to client-input steps
   * ({@link isClientInputStep}) so the server-held model-generated steps are not
   * re-sent — verified live: echoing the function_call on a chained tool round
   * returns HTTP 400, while sending only the function_result completes.
   */
  private finalizeChain(
    response: GoogleGenAIInteraction,
    totalStepCount: number,
    stateful: boolean,
  ): void {
    if (!stateful) return;
    const safeToChain =
      (response.status === 'completed' ||
        response.status === 'requires_action') &&
      typeof response.id === 'string';
    if (safeToChain) {
      // The server now holds the full transcript up to this point; the next
      // round chains onto this id and sends only Steps appended after it
      // (whether this turn was a full resend or a delta).
      this.chainState.recordChained(response.id, totalStepCount);
    } else {
      this.logger.debug(
        `Interaction ${response.id} not safe for chaining (status="${response.status}"); resending full history next round`,
      );
      this.chainState.invalidateChain();
    }
  }

  // ===========================================================================
  // Client cache + media pipeline
  // ===========================================================================

  /**
   * Inline-vs-uploaded media threshold for the Google File API: 20 MiB.
   */
  private static readonly INLINE_MEDIA_LIMIT_BYTES = 20 * 1024 * 1024;

  private googleClient: GoogleClientCache | null = null;

  /** Whether the model can accept file attachments (image/video or native audio). */
  protected supportsFileUploads(): boolean {
    return (
      this.capabilities.supportsVision || this.capabilities.supportsNativeAudio
    );
  }

  /** Whether the model is a Gemini 3 variant (different thinking/media rules). */
  protected isGemini3Model(): boolean {
    return /^gemini-3[\.\-]/.test(this.config.fullName);
  }

  protected getInlineUploadLimitBytes(): number {
    return ModelHandlerGoogleInteractions.INLINE_MEDIA_LIMIT_BYTES;
  }

  async getClient(
    selection: ModelCredentialSelection = 'configured',
  ): Promise<GoogleGenAI> {
    const credential = await this.resolveClientCredential(selection);
    return resolveGoogleClient({
      sdkLabel: this.sdkLabel,
      credential,
      logger: this.logger,
      cached: this.googleClient,
      setCached: (cache) => {
        this.googleClient = cache;
      },
      rememberRoute: (client, route, credentialSecret) =>
        this.rememberClientCredentialRoute(client, route, credentialSecret),
    });
  }

  override async refreshClient(
    selection: ModelCredentialSelection = 'configured',
  ): Promise<GoogleGenAI> {
    this.googleClient = null;
    return this.getClient(selection);
  }

  protected override get sdkErrorTagger() {
    return tagGoogleSdkError;
  }

  override get supportsForcedToolChoice(): boolean {
    return true;
  }

  /**
   * Google passes the system prompt per call as `system_instruction` rather
   * than storing it in `messages`, so the round flow must resupply it on every
   * invocation.
   */
  override get requiresPerCallSystemPrompt(): boolean {
    return true;
  }

  /**
   * Gemini carries thought signatures across parallel function calls, which must
   * be preserved by batching the results into a single follow-up: the handler
   * rebuilds the model-generated turn (thought signatures + every function call)
   * ahead of the results, in the order the model emitted them. The tool-use flow
   * only records the assistant turn through the follow-up methods (see
   * `ToolUseDispatchNode`), so splitting parallel calls across separate turns
   * would lose the signature and reference a call absent from the transcript.
   * Unconditional (not gated on `capabilities.supportsReasoning`) — see the base
   * getter's doc comment (#7101 triage).
   */
  override get requiresBatchedParallelToolResults(): boolean {
    return true;
  }

  /**
   * Map the model's reasoning effort to a Gemini `thinking_level`.
   * Interactions emits the lowercase `thinking_level` string literals.
   *
   * Returns `'low'` (not `undefined`) for `NONE` so the API does not fall
   * back to its default medium/high — that would defeat the user's intent.
   * Gemini tops out at HIGH thinking, so xhigh/max both map to it; Gemini 3 Pro
   * only supports low/high, so MEDIUM falls back to HIGH for Pro.
   */
  protected getThinkingLevel(): ThinkingLevel | undefined {
    const isGemini3 = this.isGemini3Model();

    switch (this.capabilities.reasoningEffort) {
      case ReasoningEffort.NONE:
        if (isGemini3) {
          this.logger.warn(
            "Gemini 3 models can't fully disable thinking. Using thinking_level 'low'.",
          );
        }
        return 'low';

      case ReasoningEffort.LOW:
        return 'low';

      case ReasoningEffort.MEDIUM:
        if (isGemini3 && this.config.fullName.includes('-pro')) {
          this.logger.debug(
            'Gemini 3 Pro does not support medium thinking level. Using high.',
          );
          return 'high';
        }
        return 'medium';

      case ReasoningEffort.HIGH:
      case ReasoningEffort.XHIGH:
      case ReasoningEffort.MAX:
        return 'high';

      default:
        return undefined;
    }
  }

  protected override async createMediaMessage(
    mediaFiles: FileLocation[],
  ): Promise<Content[]> {
    if (!mediaFiles?.length || !this.supportsFileUploads()) {
      return [];
    }

    const { entries, results } =
      await this.mediaProcessor.loadEntries(mediaFiles);
    this.mediaProcessor.logResults(results);

    if (entries.length === 0) {
      return [];
    }

    return this.uploadMediaEntries(entries);
  }

  /** Media blocks for the entries (inline when small enough, uploaded otherwise). */
  protected async uploadMediaEntries(
    entries: MediaEntry[],
  ): Promise<Content[]> {
    const insertedEntries: MediaEntry[] = [];
    const media = await uploadGoogleMediaEntries<Content>(entries, {
      getClient: () => this.getClient(),
      inlineLimit: this.getInlineUploadLimitBytes(),
      logger: this.logger,
      buildMedia: (source, mimeType) => this.buildMedia(source, mimeType),
      onInsertedEntry: (entry) => insertedEntries.push(entry),
    });
    this.setCreatedMediaEntriesForAttachmentLog(insertedEntries);
    return media;
  }

  /** Labelled media for a round, or empty when there is nothing to attach. */
  protected async buildLabelledMedia(
    mediaFiles: FileLocation[] | undefined,
    context: 'initial' | 'followUp',
  ): Promise<Content[]> {
    if (!mediaFiles?.length || !this.supportsFileUploads()) {
      return [];
    }

    const media = await this.createMediaForRound(mediaFiles, context);
    if (media.length === 0) {
      return [];
    }

    const label = mediaFiles.map((loc) => getShortDisplayPath(loc)).join(', ');
    const verb = context === 'initial' ? 'Attached' : 'Processing';
    return [
      this.textMedia(
        `\n${verb} ${pluralize(mediaFiles.length, 'file')}: ${label}`,
      ),
      ...media,
    ];
  }

  /**
   * Follow-up for a SINGLE tool call, built by delegating to the batched
   * path with a one-entry array so both call sites share one assembly.
   */
  async createToolUseFollowUpMessages(
    _client: GoogleGenAI | undefined,
    call: GoogleToolCall,
    result: ToolResult,
    attachments: ToolFileAttachment[],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<Step[]> {
    if (!call.callId) {
      throw new Error('Function call id is required for follow-up messages');
    }

    return this.createBatchedToolUseFollowUpMessages(
      [{ call, result, attachments }],
      workspaceState,
      text,
    );
  }

  // ===========================================================================
  // Capability getters / auth (REUSE / PORT from the chat handler)
  // ===========================================================================

  /** `apiVersion` is left unset for v0 — see spec §6.4. */
  protected get sdkLabel(): string {
    return 'Interactions';
  }

  /**
   * Optional `resolution` field for an Interactions media `Content`: Gemini 3
   * images use high resolution; everything else omits the field.
   */
  private mediaResolutionFields(mimeType: string): {
    resolution?: MediaResolution;
  } {
    // Interactions DocumentContent currently has no resolution field, so PDF
    // resolution cannot be selected until the SDK exposes it.
    if (this.isGemini3Model() && mimeType.startsWith('image/')) {
      return { resolution: 'high' };
    }
    return {};
  }

  /**
   * The handler implements client-side compaction (see `compactConversation`),
   * so manual (user-requested) compaction is supported. Always true: the
   * Interactions handler is never reached through OpenRouter (the routing
   * predicate excludes it), so the OpenAI-style OpenRouter guard is moot.
   */
  override get supportsManualCompaction(): boolean {
    return true;
  }

  // ===========================================================================
  // Token counting (REUSE — countTokens is unchanged in Interactions)
  // ===========================================================================

  override async estimateTokenCount(
    messages: Step[],
    options?: TokenCountOptions<GoogleGenAI>,
  ): Promise<number> {
    const client = options?.client ?? (await this.getClient());

    // Token counting stays on the chat `countTokens` endpoint. Convert
    // Interactions content blocks back to countable chat parts so media-heavy
    // runs are budgeted against their actual attachments, not only labels.
    const countContents = [];
    if (options?.systemPrompt) {
      countContents.push({
        role: 'system',
        parts: [createPartFromText(options.systemPrompt)],
      });
    }
    countContents.push(...this.stepsToCountableContents(messages));

    // Include tool definitions in the count (parity with the chat handler) so
    // the preflight doesn't under-count when tools are present. countTokens is
    // the chat endpoint, so convert to the chat tool shape, not Interactions'.
    const toolDefs = options?.tools as ToolDefinition[] | undefined;
    const googleTools = toolDefs?.length ? toGoogleTools(toolDefs) : undefined;

    const responseTokenCount = await client.models.countTokens({
      model: this.config.fullName,
      contents: countContents,
      config: {
        abortSignal: options?.signal,
        ...(googleTools?.length && { tools: googleTools }),
      },
    });

    const totalTokens = responseTokenCount.totalTokens ?? 0;
    this.logger.debug(`Token count of message: ${totalTokens}`);
    // SMOKE-TEST: under previous_interaction_id chaining the local `messages`
    // over-counts (the server holds most of the transcript). We deliberately
    // keep estimating on the FULL local transcript — over-estimating input only
    // makes applyTokenCountLimit MORE cautious (shrinks max_output_tokens) and
    // never under-budgets. Exact server-side token accounting under chaining is
    // unconfirmed offline (spec §6 S1); revisit only if a real-key run shows
    // the conservative estimate harms output budget materially.
    this.chainState.setCumulativeInputTokens(totalTokens);
    return totalTokens;
  }

  private contentToCountablePart(content: Content): Part | null {
    if (isTextContent(content)) return createPartFromText(content.text);

    const mimeType =
      'mime_type' in content
        ? (content.mime_type ?? DEFAULT_ATTACHMENT_MIME_TYPE)
        : DEFAULT_ATTACHMENT_MIME_TYPE;
    const resolution =
      content.type === 'image' && content.resolution
        ? COUNTABLE_MEDIA_RESOLUTION_BY_LEVEL[content.resolution]
        : undefined;

    if ('data' in content && isNonEmptyString(content.data)) {
      return createPartFromBase64(content.data, mimeType, resolution);
    }
    if ('uri' in content && isNonEmptyString(content.uri)) {
      return createPartFromUri(content.uri, mimeType, resolution);
    }
    return null;
  }

  /** Convert the step transcript to chat Content for the countTokens estimate. */
  private stepsToCountableContents(steps: Step[]) {
    const contents = [];
    for (const step of steps) {
      if (step.type === 'user_input' || step.type === 'model_output') {
        const parts = (step.content ?? [])
          .map((content) => this.contentToCountablePart(content))
          .filter(filterNotNull);
        if (parts.length > 0) {
          contents.push({
            role: step.type === 'model_output' ? 'model' : 'user',
            parts,
          });
        }
      } else if (step.type === 'function_call') {
        contents.push(
          createUserContent(`${step.name}(${JSON.stringify(step.arguments)})`),
        );
      } else if (step.type === 'function_result') {
        const parts = Array.isArray(step.result)
          ? step.result
              .map((content) => this.contentToCountablePart(content))
              .filter(filterNotNull)
          : [createPartFromText(this.functionResultToText(step.result))];
        if (parts.length > 0) {
          contents.push(createUserContent(parts));
        }
      } else if (step.type === 'thought') {
        const parts = (step.summary ?? [])
          .filter(isTextContent)
          .map((content) => createPartFromText(content.text));
        if (parts.length > 0) {
          contents.push(createUserContent(parts));
        }
      }
    }
    return contents;
  }

  /** Flatten the step transcript to plain text for client-side summarization. */
  private stepsToTextTranscript(steps: Step[]): string {
    const chunks: string[] = [];
    for (const step of steps) {
      if (step.type === 'user_input' || step.type === 'model_output') {
        for (const content of step.content ?? []) {
          if (isTextContent(content)) chunks.push(content.text);
        }
      } else if (step.type === 'function_call') {
        chunks.push(`${step.name}(${JSON.stringify(step.arguments)})`);
      } else if (step.type === 'function_result') {
        chunks.push(this.functionResultToText(step.result));
      } else if (step.type === 'thought') {
        for (const content of step.summary ?? []) {
          if (isTextContent(content)) chunks.push(content.text);
        }
      }
    }
    return joinNonEmpty(chunks, '\n') ?? '';
  }

  // ===========================================================================
  // Usage / price (PORT — delegate to the snake_case adapter)
  // ===========================================================================

  computePrice(responseUsage: Usage | null): number {
    return computeGoogleInteractionsPrice(
      responseUsage,
      this.standardPricingConfig(),
    );
  }

  normalizeUsage(
    rawUsage: Usage | null,
    responseTimeMs: number,
  ): NormalizedUsage {
    return normalizeGoogleInteractionsUsage(
      rawUsage,
      responseTimeMs,
      this.standardPricingConfig(),
    );
  }

  // ===========================================================================
  // Message construction (typed Content + Step[], not chat parts)
  // ===========================================================================

  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: FileLocation[],
    _systemPrompt?: string,
  ): Promise<Step[]> {
    // System prompt is NOT a step — it rides on request-level system_instruction
    // (resent on every create, spec §6.2).
    const content: Content[] = [
      ...(userPrefix.trim() ? [this.textMedia(userPrefix)] : []),
      ...(await this.buildLabelledMedia(mediaFiles, 'initial')),
    ];
    if (userRequest.trim()) {
      const separator = content.length > 0 ? '\n' : '';
      content.push(this.textMedia(`${separator}${userRequest}`));
    }

    if (content.length === 0) {
      throw new Error(
        'Google messages require a non-empty user prefix, request, or attachment.',
      );
    }

    return [{ type: 'user_input', content } satisfies UserInputStep];
  }

  async createRoundMessages(
    messages: Step[],
    userMessage: string,
    mediaFiles?: FileLocation[],
  ): Promise<Step[]> {
    const content: Content[] = [
      ...(await this.buildLabelledMedia(mediaFiles, 'followUp')),
      ...(userMessage.trim() ? [this.textMedia(userMessage)] : []),
    ];

    if (content.length === 0) {
      throw new Error(
        'Google follow-up messages require non-empty text or an attachment.',
      );
    }

    messages.push({ type: 'user_input', content } satisfies UserInputStep);
    return messages;
  }

  async createUserFollowUpMessages(
    messages: Step[],
    userMessage: string,
  ): Promise<Step[]> {
    if (!userMessage.trim()) return messages;
    const last = messages.at(-1);
    if (last?.type === 'user_input') {
      (last.content ??= []).push(this.textMedia(userMessage));
    } else {
      messages.push({
        type: 'user_input',
        content: [this.textMedia(userMessage)],
      } satisfies UserInputStep);
    }
    return messages;
  }

  createAssistantMessage(text: string): Step {
    return {
      type: 'model_output',
      content: [this.textMedia(text)],
    } satisfies ModelOutputStep;
  }

  override extractAssistantText(message: Step): string | undefined {
    if (message.type !== 'model_output') return undefined;
    return joinNonEmpty(
      (message.content ?? []).filter(isTextContent).map((c) => c.text),
    );
  }

  protected textMedia(text: string): TextContent {
    if (!text) {
      throw new Error('Google text content must not be empty.');
    }
    return { type: 'text', text };
  }

  /**
   * Build a typed media `Content` from either inline base64 (`data`) or an
   * uploaded File API `uri`, dispatching on the mime type. (Single builder for
   * both sources — the only difference is the data/uri field.)
   */
  protected buildMedia(source: GoogleMediaSource, mimeType: string): Content {
    if (mimeType.startsWith('image/')) {
      return {
        type: 'image',
        ...source,
        mime_type: mimeType,
        ...this.mediaResolutionFields(mimeType),
      } satisfies ImageContent;
    }
    if (mimeType.startsWith('audio/')) {
      return {
        type: 'audio',
        ...source,
        mime_type: mimeType,
      } satisfies AudioContent;
    }
    if (mimeType.startsWith('video/')) {
      return {
        type: 'video',
        ...source,
        mime_type: mimeType,
      } satisfies VideoContent;
    }
    return {
      type: 'document',
      ...source,
      mime_type: mimeType,
    } satisfies DocumentContent;
  }

  // ===========================================================================
  // Response extraction (walk steps, not candidate parts)
  // ===========================================================================

  extractResponse(
    responseObject: GoogleGenAIInteraction,
    endTag: string,
  ): ExtractResponseResult {
    if (!responseObject) {
      this.logger.error('Invalid (null) response object received.');
      return {
        text: '',
        usage: undefined,
        stopReason: 'UNKNOWN_EMPTY_RESPONSE',
      };
    }

    let responseText = this.postProcessResponse(
      rawModelOutputText(responseObject),
    );
    const usage = responseObject.usage;
    // Map the Interactions terminal *status* to the canonical Google chat
    // FinishReason the shared stop/continue logic understands (mirrors the
    // OpenAI Responses handler at extractResponse). `checkStopConditions` keys
    // `endTurn` on GOOGLE_FINISH.STOP and `shouldContinue` /
    // `isTokenLimitStopReason` key truncation on GOOGLE_FINISH.MAX_TOKENS; the
    // raw 'completed' / 'incomplete' status strings match neither, so a clean
    // completion ending on the document tag would be misread as
    // `shouldStop && !endTurn` — i.e. a user cancellation — and its
    // already-generated output discarded. Non-terminal statuses (e.g.
    // 'requires_action' for tool-call rounds) pass through unchanged.
    const status = responseObject.status ?? 'completed';
    let stopReason: ProviderStopReason;
    switch (status) {
      case 'completed':
        stopReason = GOOGLE_FINISH.STOP;
        break;
      case 'incomplete':
        stopReason = GOOGLE_FINISH.MAX_TOKENS;
        break;
      default:
        // Non-terminal statuses (e.g. 'requires_action') pass through unchanged.
        stopReason = status;
    }

    // If the model completed naturally without the end tag, append it (mirrors
    // the chat handler's STOP behavior, keyed on the terminal completion).
    if (
      stopReason === GOOGLE_FINISH.STOP &&
      endTag &&
      responseText.length > 0 &&
      !responseText.endsWith(endTag)
    ) {
      this.logger.debug(
        `Model completed but didn't include end tag. Appending ${endTag}.`,
      );
      responseText += `\n${endTag}`;
    }

    return { text: responseText, usage, stopReason };
  }

  processThinkingBlock(
    responseObject: GoogleGenAIInteraction,
    workspaceState?: AgentWorkspaceState,
  ): string | null {
    const steps = responseObject?.steps ?? [];
    const thoughtSteps = steps.filter(
      (s): s is ThoughtStep => s.type === 'thought',
    );
    if (thoughtSteps.length === 0) return null;

    // Flatten each thought step's summary once, then reuse for both the return
    // value and the workspace reasoning cache.
    const perStepText = thoughtSteps.map((s) =>
      joinTextContent(s.summary ?? []),
    );
    const thoughtContent = perStepText.join('').trim();

    if (
      workspaceState &&
      workspaceState.reasoning.thinkingBlocks.length === 0
    ) {
      workspaceState.reasoning.thinkingBlocks = thoughtSteps.map((s, i) => ({
        type: 'thinking',
        thinking: perStepText[i],
        signature: s.signature,
      }));
    }

    if (thoughtContent) {
      this.logger.debug('Google Interactions thought summary preview.', {
        data: thoughtContent.slice(0, K_SLICE),
      });
    }
    return thoughtContent || null;
  }

  extractToolUse(responseObject: GoogleGenAIInteraction): GoogleToolCall[] {
    const steps = responseObject?.steps ?? [];
    return steps
      .filter((s): s is FunctionCallStep => s.type === 'function_call')
      .map((step): GoogleToolCall => ({
        provider: 'google',
        callId: step.id ?? generateShortId(),
        name: step.name,
        input: step.arguments,
        // GoogleToolCall.raw is a chat `FunctionCall`; reconstruct the shape the
        // downstream code reads (name/args/id) from the Interactions step.
        raw: { id: step.id, name: step.name, args: step.arguments },
      }));
  }

  // ===========================================================================
  // Stop / continue (PORT — keyed on Interaction status, not FinishReason)
  // ===========================================================================

  protected appendUserText(messages: Step[], text: string): void {
    messages.push({
      type: 'user_input',
      content: [this.textMedia(text)],
    } satisfies UserInputStep);
  }

  protected appendTextToLastAssistantMessage(
    messages: Step[],
    text: string,
    options: { afterContinuationPrompt?: boolean } = {},
  ): boolean {
    const trailingStep = messages.at(-1);
    if (
      options.afterContinuationPrompt &&
      trailingStep?.type === 'user_input'
    ) {
      if (
        this.containCutOffMessage(joinTextContent(trailingStep.content ?? []))
      ) {
        messages.pop();
        this.logger.debug('Removed user continuation prompt.');
      } else {
        return false;
      }
    }

    const modelStep = messages.at(-1);
    if (modelStep?.type !== 'model_output') return false;

    const content = (modelStep.content ??= []);
    const lastText = content.findLast(isTextContent);
    if (lastText) {
      lastText.text = (lastText.text ?? '') + text;
    } else {
      content.push(this.textMedia(text));
      this.logger.warn(
        'Added new text content to last model_output step as none existed.',
      );
    }
    return true;
  }

  // ===========================================================================
  // Tool round-trip (REWRITE — verbatim Step[] + a function_result step)
  // ===========================================================================

  /**
   * Follow-up for MULTIPLE parallel tool calls. All model-generated steps
   * (thoughts + every function-call step) are emitted together in model-emitted
   * order, followed by every function_result step — mirroring the chat handler's
   * batched path, re-expressed as Interactions `Step[]` (spec §6.1).
   */
  async createBatchedToolUseFollowUpMessages(
    entries: Array<{
      call: GoogleToolCall;
      result: ToolResult;
      attachments: ToolFileAttachment[];
    }>,
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<Step[]> {
    if (entries.length === 0) return [];
    for (const [index, { call }] of entries.entries()) {
      if (!call.callId) {
        throw new Error(
          `Function call at index ${index} (${call.name ?? 'unknown'}) is missing callId`,
        );
      }
    }

    const assistantSteps = this.buildAssistantTurnSteps(
      entries.map((e) => e.call),
      workspaceState,
      text,
    );
    const resultSteps = await Promise.all(
      entries.map(({ call, result, attachments }) =>
        this.buildFunctionResultStep(call, result, attachments),
      ),
    );

    if (workspaceState) {
      workspaceState.resetServerToolContent();
      workspaceState.resetReasoning();
    }

    return [...assistantSteps, ...resultSteps];
  }

  /**
   * Build a `thought` step from an optional signature and thinking summary, or
   * `undefined` when both are empty (an empty thought step is noise on the wire).
   */
  private thoughtStep(
    signature?: string,
    thinking?: string,
  ): ThoughtStep | undefined {
    if (!signature && !thinking) return undefined;
    return {
      type: 'thought',
      ...(signature ? { signature } : {}),
      ...(thinking ? { summary: [{ type: 'text', text: thinking }] } : {}),
    } satisfies ThoughtStep;
  }

  /**
   * Reconstruct the model-generated steps of the just-finished turn: the
   * thought steps (carrying their signatures, sourced from the reasoning cache
   * populated by `processThinkingBlock`), optional assistant text, then the
   * function-call steps. Carried verbatim in the transcript so the backend can
   * validate reasoning across tool turns (resent each round in stateless mode;
   * retained server-side once sent in chained mode).
   */
  private buildAssistantTurnSteps(
    calls: GoogleToolCall[],
    workspaceState: AgentWorkspaceState | undefined,
    text: string | undefined,
  ): Step[] {
    const steps: Step[] = [];

    for (const block of workspaceState?.reasoning.thinkingBlocks ?? []) {
      const step = this.thoughtStep(block.signature, block.thinking);
      if (step) steps.push(step);
    }

    if (text) {
      steps.push(this.createAssistantMessage(text));
    }

    for (const call of calls) {
      steps.push({
        type: 'function_call',
        id: call.callId ?? generateShortId(),
        name: call.name ?? '',
        arguments: (call.input ?? {}) as Record<string, unknown>,
      } satisfies FunctionCallStep);
    }

    return steps;
  }

  /** Build a `function_result` step, embedding tool-result images inline. */
  private async buildFunctionResultStep(
    call: GoogleToolCall,
    result: ToolResult,
    attachments: ToolFileAttachment[],
  ): Promise<FunctionResultStep> {
    const subcontent: FunctionResultSubcontent[] = [];
    let attachmentSummary: string | undefined;

    if (this.canProcessToolResultAttachments && attachments.length > 0) {
      attachmentSummary = formatAttachmentSummary(
        attachments,
        'included-inline',
      );
      const encoded = (
        await Promise.all(
          attachments.map((a) => this.buildFunctionResultImage(a)),
        )
      ).filter(filterNotNull);
      subcontent.push(...encoded);
      if (encoded.length === 0) {
        this.logger.warn(
          `All attachments for Interactions function result '${call.name}' failed to encode.`,
        );
      }
    }

    const text = formatToolResultAsText(result, attachmentSummary);
    const resultContent: FunctionResultSubcontent[] = [
      { type: 'text', text },
      ...subcontent,
    ];

    return {
      type: 'function_result',
      call_id: call.callId,
      name: call.name,
      ...(result.status === 'error' ? { is_error: true } : {}),
      result: resultContent,
    } satisfies FunctionResultStep;
  }

  private async buildFunctionResultImage(
    attachment: ToolFileAttachment,
  ): Promise<ImageContent | null> {
    try {
      const buffer = await loadAttachmentBuffer(attachment);
      if (!buffer || buffer.length === 0) {
        this.logger.warn(
          `Skipping empty attachment '${attachment.path}' in Interactions function result.`,
        );
        return null;
      }
      const mimeType = attachment.mimeType ?? DEFAULT_ATTACHMENT_MIME_TYPE;
      return {
        type: 'image',
        data: buffer.toString('base64'),
        mime_type: mimeType,
      } satisfies ImageContent;
    } catch (error) {
      reportMediaAttachmentFailure(
        this.logger,
        'toolAttachment',
        error,
        `failed to encode '${attachment.path}' for Interactions function result`,
      );
      return null;
    }
  }

  /** Flatten a function-result payload's `result` field to plain text. */
  private functionResultToText(result: FunctionResultStep['result']): string {
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) {
      return joinTextContent(result);
    }
    return '';
  }

  // ===========================================================================
  // Message modification (post-build enrichment)
  // ===========================================================================

  prependTextToUserMessage(messages: Step[], text: string): void {
    if (!text.trim()) return;
    const lastUser = messages.findLast(
      (s): s is UserInputStep => s.type === 'user_input',
    );
    if (lastUser) {
      (lastUser.content ??= []).unshift(this.textMedia(text));
    }
  }

  async addMediaToUserMessage(
    messages: Step[],
    mediaFiles: FileLocation[],
  ): Promise<MediaAttachmentKind[]> {
    if (!mediaFiles.length || !this.supportsFileUploads()) return [];
    const media = await this.createMediaForRound(mediaFiles, 'insert');
    if (media.length === 0) return [];
    const trailing = messages.at(-1);
    const lastUser =
      trailing?.type === 'user_input' &&
      messages.length > this.chainState.getSentCount()
        ? trailing
        : ({ type: 'user_input', content: [] } satisfies UserInputStep);
    if (lastUser !== trailing) messages.push(lastUser);
    (lastUser.content ??= []).unshift(...media);
    return this.consumeInsertedAttachmentKinds('insert');
  }

  // ===========================================================================
  // The streaming loop — createResponseImpl (REWRITE, the core)
  // ===========================================================================

  /**
   * Single-turn guard: concurrent callers would race the chain-state
   * collaborator's anchor id / sent-Step count and corrupt the chain.
   */
  protected override withCreateResponseGuard<T>(
    run: () => Promise<T>,
  ): Promise<T> {
    return this.withSingleTurnGuard('modelHandlerGoogleInteractions', run);
  }

  protected override async createResponseImpl(
    options: CreateResponseOptions<Step, GoogleGenAI>,
  ): Promise<CreateResponseResult<GoogleGenAIInteraction, Step>> {
    const { client, messages, systemPrompt, endTag, signal, tools, finalTool } =
      options;
    if (messages.length === 0) {
      this.logger.error('Cannot create response from empty messages array.');
      throw new Error('Messages array cannot be empty.');
    }

    // Result of an in-call compaction, surfaced as
    // CreateResponseResult.updatedMessages. Scoped to this attempt: a retry
    // re-enters with a fresh binding, so no stale value can leak across
    // attempts (maybeCompactByInputTokens owns cross-attempt reuse).
    let updatedMessages: Step[] | undefined;

    const stateful = this.serverStateEnabled();
    // Observing stateless mode invalidates any prior chain immediately. This is
    // deliberately before token work, pending retrieval, and dispatch so every
    // exit path (including timeout, abort, terminal status, or retrieval error)
    // leaves a later re-enable on a safe full-resend boundary.
    if (!stateful) this.chainState.invalidateChain();

    this.backgroundLifecycle.assertPendingNotAborted(client, signal);

    const generationConfig = this.buildGenerationConfig(endTag);
    const interactionsTools = tools?.length
      ? this.toInteractionsTools(tools)
      : undefined;
    if (finalTool && interactionsTools) {
      generationConfig.tool_choice = finalTool.name;
    }

    // Phase: COUNT + VALIDATE — adjust max_output_tokens to fit the context
    // window. Estimate on the FULL local transcript (conservative — see
    // estimateTokenCount's SMOKE-TEST note); this also refreshes
    // the chain state's cumulative input-token count, which drives the
    // compaction trigger below.
    await this.applyTokenCountLimit({
      countTokens: () =>
        this.estimateTokenCount(messages, {
          client,
          systemPrompt,
          signal,
          tools,
        }),
      currentMaxTokens: generationConfig.max_output_tokens ?? 8192,
      contextWindow: this.config.contextWindow,
      detailLabel:
        'Google Interactions: max_output_tokens reduced to fit context window',
      applyReduced: (adjusted) => {
        generationConfig.max_output_tokens = adjusted;
      },
    });

    // Phase: COMPACT (stateful only) — when input tokens exceed the threshold
    // (or compaction was manually requested), summarize and replace history.
    // Compaction invalidates the chain: the server still holds the
    // pre-compaction interaction under the old id, so chaining onto it would
    // double the context. After compaction the next round full-resends the
    // compacted transcript and re-establishes a fresh chain.
    if (stateful) {
      const { compactedMessages, didCompact } =
        await this.maybeCompactByInputTokens(
          messages,
          this.chainState.getCumulativeInputTokens(),
          () =>
            this.compactConversation(
              client,
              messages,
              this.chainState.getCumulativeInputTokens(),
              systemPrompt,
              signal,
            ),
        );
      if (didCompact) {
        updatedMessages = compactedMessages;
        this.chainState.invalidateChain();
      }
    }

    const base = updatedMessages ?? messages;

    // First request OR post-compaction OR stateless ⇒ full resend with no chain.
    // Continuation ⇒ send only the CLIENT-INPUT Steps appended since the last
    // send (user_input / function_result). The model-generated steps the flow
    // also appends to the local transcript (thought / function_call /
    // model_output) are already held by the chained interaction, and re-sending
    // them is rejected — verified live: echoing the function_call on a chained
    // tool round returns HTTP 400, while sending only the function_result
    // completes. Filtering to client-input steps fixes both the tool-round 400
    // and the text-round assistant-turn re-send.
    const shouldSendAll = !stateful || this.chainState.getAnchorId() === null;
    const inputSteps = omitEmptyTextContentFromSteps(
      shouldSendAll
        ? base
        : base.slice(this.chainState.getSentCount()).filter(isClientInputStep),
    );
    // `!shouldSendAll` already implies `stateful` with a non-null chain anchor
    // (stateless or anchor-less forces a full resend); `?? undefined` only
    // converts getAnchorId's `string | null` for the wire shape.
    const previousId = shouldSendAll
      ? undefined
      : (this.chainState.getAnchorId() ?? undefined);

    // Dispatch order: background > streaming > non-streaming. When background is
    // active, getStreamingConfig() already returns false, so useStreaming is
    // false and the streaming/non-streaming branches stay byte-identical when
    // background is off.
    // A known remote interaction takes precedence over current settings: once
    // submitted, disabling background or server state must not replace it with a
    // foreground create. New submissions still obey the normal eligibility gate.
    const useBackground =
      this.backgroundLifecycle.hasPendingResume() ||
      this.useBackgroundMode(stateful);
    // super.getStreamingConfig() (not this.) — the override would recompute
    // background mode (extra config reads) when we already know useBackground.
    const useStreaming = !useBackground && super.getStreamingConfig();

    return this.dispatchGoogleInteractionsExecution({
      client,
      inputSteps,
      stateful,
      previousId,
      systemPrompt,
      interactionsTools,
      generationConfig,
      signal,
      endTag,
      baseLength: base.length,
      useBackground,
      useStreaming,
      updatedMessages,
      options,
    });
  }

  /**
   * Dispatch phase: build the common request shape and route through
   * background / streaming / non-streaming, including the shared error
   * recovery (background-unsupported fallback and stale-chain retry, both
   * self-recursive back into {@link createResponseImpl}). Extracted from
   * {@link createResponseImpl} verbatim; it is the tail of that method, so it
   * returns the final {@link CreateResponseResult} directly.
   */
  private async dispatchGoogleInteractionsExecution(args: {
    client: GoogleGenAI;
    inputSteps: Step[];
    stateful: boolean;
    previousId: string | undefined;
    systemPrompt: string | undefined;
    interactionsTools: FunctionT[] | undefined;
    generationConfig: GenerationConfig;
    signal: AbortSignal | undefined;
    endTag: string | undefined;
    baseLength: number;
    useBackground: boolean;
    useStreaming: boolean;
    updatedMessages: Step[] | undefined;
    options: CreateResponseOptions<Step, GoogleGenAI>;
  }): Promise<CreateResponseResult<GoogleGenAIInteraction, Step>> {
    const {
      client,
      inputSteps,
      stateful,
      previousId,
      systemPrompt,
      interactionsTools,
      generationConfig,
      signal,
      endTag,
      baseLength,
      useBackground,
      useStreaming,
      updatedMessages,
      options,
    } = args;

    let aggregatedText = '';

    const withUpdated = (
      result: CreateResponseResult<GoogleGenAIInteraction, Step>,
    ): CreateResponseResult<GoogleGenAIInteraction, Step> =>
      updatedMessages ? { ...result, updatedMessages } : result;

    // Common request shape — only `stream` differs between the two branches.
    const commonParams = {
      model: this.config.fullName,
      input: inputSteps,
      store: stateful,
      ...(previousId && { previous_interaction_id: previousId }),
      ...(systemPrompt && { system_instruction: systemPrompt }),
      ...(interactionsTools && { tools: interactionsTools }),
      generation_config: generationConfig,
    };
    const requestOptions = this.interactionsRequestOptions(signal);

    try {
      if (useBackground) {
        const result = await this.executeBackgroundPath(
          client,
          commonParams,
          baseLength,
          stateful,
          requestOptions,
          signal,
        );
        return withUpdated(result);
      }

      if (useStreaming) {
        const params: CreateModelInteractionParamsStreaming = {
          ...commonParams,
          stream: true,
        };
        const stream = (await client.interactions.create(
          params,
          requestOptions,
        )) as Stream<InteractionSSEEvent>;
        const result = await this.consumeStream(stream, endTag, (text) => {
          aggregatedText += text;
        });
        this.finalizeChain(result.response, baseLength, stateful);
        return withUpdated(result);
      }

      // Not annotated with `CreateModelInteractionParamsNonStreaming`: the
      // SDK's public export of that name (`Interactions.*`) is only the
      // request-body subset and doesn't line up with the (unexported)
      // parameter type its own `create()` overload for this shape expects,
      // so an explicit annotation here would make TS fall through to
      // `create()`'s most general overload and lose the precise response type.
      // Leaving `params` inferred keeps its structural type (which does
      // include `model`/`input`/`store` from `commonParams`) matching that
      // overload, so `response` comes back correctly typed with no cast.
      const params = {
        ...commonParams,
        stream: false as const,
      };
      const response = await client.interactions.create(params, requestOptions);
      this.finalizeChain(response, baseLength, stateful);
      return withUpdated({ response });
    } catch (error) {
      // Model doesn't support background interactions (e.g. gemini-2.5-flash ⇒
      // HTTP 400) ⇒ disable background for this instance and retry on the
      // streaming / non-streaming path. Bounded: backgroundUnsupported makes
      // useBackgroundMode() false on the retry, so it cannot re-hit this error.
      if (
        useBackground &&
        !this.backgroundLifecycle.hasPendingResume() &&
        isBackgroundUnsupportedError(error)
      ) {
        this.logger.warn(
          `Model ${this.config.fullName} does not support background interactions; ` +
            `falling back to foreground for this run.`,
        );
        this.backgroundUnsupported = true;
        return this.createResponseImpl(options);
      }
      // Expired/unknown previous_interaction_id ⇒ drop the chain and full-resend
      // exactly once. Bounded: invalidateChain() nulls the chain anchor, so
      // the retry takes the shouldSendAll path with no previous_interaction_id
      // and cannot re-trigger the same stale-id error.
      if (
        stateful &&
        this.chainState.getAnchorId() !== null &&
        isStaleInteractionChainError(error)
      ) {
        this.logger.debug(
          `Clearing chainedInteractionId=${this.chainState.getAnchorId()} (stale/expired); retrying with a full resend`,
        );
        this.chainState.invalidateChain();
        return this.createResponseImpl(options);
      }
      if (aggregatedText) {
        attachPartialText(
          error,
          takeTail(aggregatedText, PARTIAL_TEXT_TAIL_MAX),
        );
      }
      throw error;
    }
  }

  // ===========================================================================
  // BACKGROUND path (submit background:true, poll get(id), cancel on abort)
  // ===========================================================================

  /**
   * Per-call options for the Speakeasy Interactions client.
   *
   * `maxRetries: 0` keeps the node loop the single retry owner: the generated
   * client defaults to its own 4-retry backoff, which `httpOptions`-level
   * retry settings do not govern. Abort is wired via `fetchOptions.signal`
   * (GoogleGenAIRequestOptions has no top-level abortSignal field). The
   * dispatcher threads the shared 30-minute stream-inactivity budget through
   * the SDK's typed fetchOptions seam — `dispatcher` is undici's non-standard
   * RequestInit extension honored by Node's fetch but absent from the DOM lib
   * types this repo compiles against, hence the cast. Verified against
   * @google/genai 2.12.0 (fetchOptions spreads into the Request init and
   * survives the SDK's clone/rewrap); re-verify the seam on SDK bumps.
   */
  private interactionsRequestOptions(
    signal?: AbortSignal,
  ): InteractionsRequestOptions {
    return {
      maxRetries: 0,
      fetchOptions: {
        ...(signal ? { signal } : {}),
        dispatcher: composeLongRunningModelDispatcher(),
      } as RequestInit,
    };
  }

  /**
   * BACKGROUND path: submit with background:true + store:true, capture the id,
   * poll interactions.get(id) until a terminal status, finalize the chain off the
   * COMPLETED polled interaction (not the submit response), and surface the same
   * CreateResponseResult shape the streaming / non-streaming paths return. The
   * submit still carries the delta `input` + previous_interaction_id from
   * commonParams, so chaining composes with background unchanged. Cancels the
   * in-flight interaction on abort. Mirrors ModelHandlerOpenAIResponse.
   *
   * Generic (rather than annotating `commonParams` with the public
   * `CreateModelInteractionParamsNonStreaming` alias) so the caller's actual
   * request-shape fields (`model`/`input`/`store`/…) survive into
   * `submitParams` below — see the comment on the sibling non-streaming
   * `create()` call in `createResponseImpl` for why the public alias by
   * itself would make TS pick `create()`'s most general overload.
   */
  private async executeBackgroundPath<
    P extends Omit<CreateModelInteractionParamsNonStreaming, 'stream'>,
  >(
    client: GoogleGenAI,
    commonParams: P,
    totalStepCount: number,
    stateful: boolean,
    requestOptions: InteractionsRequestOptions,
    signal: AbortSignal | undefined,
  ): Promise<CreateResponseResult<GoogleGenAIInteraction, Step>> {
    // A NEW background submission requires server-side state. A known pending
    // interaction was already submitted with store:true and must still be
    // retrieved if the setting changed while its poll was being retried.
    if (!stateful && !this.backgroundLifecycle.hasPendingResume()) {
      throw new Error(
        'Background mode requires server-side state (store:true); refusing to ' +
          'submit a background interaction in stateless mode.',
      );
    }

    if (this.backgroundLifecycle.hasPendingResume()) {
      // Resume the interaction a prior attempt left pending: the lifecycle
      // re-checks the abort/deadline boundaries, retrieves it (mapping abort,
      // expiry, and stale-id outcomes to their pinned errors), and polls it
      // to a terminal status.
      const resumed = await this.backgroundLifecycle.tryResume(client, signal);
      if (resumed !== null) {
        this.finalizeChain(resumed, totalStepCount, stateful);
        return { response: resumed };
      }
      // The Google hooks never yield null (definitive resume failures throw
      // instead of auto-restarting), but honor the lifecycle contract and
      // fall through to a fresh submission.
    }

    // background:true forces store:true (already true under `stateful`).
    const submitParams = {
      ...commonParams,
      stream: false as const,
      store: true,
      background: true,
    };
    logProgressStatus(
      this.logger,
      'Running Google Interactions in background mode; polling for completion ' +
        '(this may take longer than usual).',
    );
    // SMOKE-TEST: the initial status of a background:true create, and whether
    // background:true is accepted with store:true (and rejected/ignored with
    // store:false), are unconfirmed offline; verify on a real-key run.
    const initial = await client.interactions.create(
      submitParams,
      requestOptions,
    );

    let completed: GoogleGenAIInteraction;
    if (typeof initial.id !== 'string') {
      // No id ⇒ cannot poll. Trust the submit response (its status drives
      // finalizeChain, which invalidates the chain if not 'completed').
      this.logger.warn(
        'Background submit returned no interaction id; skipping polling.',
      );
      completed = initial;
    } else {
      completed = await this.backgroundLifecycle.waitForCompletion(
        client,
        initial,
        signal,
      );
    }

    // Capture the chain anchor from the COMPLETED polled interaction (NOT the
    // submit), so the next turn chains onto a server-retained, completed id.
    // Stateless mode invalidated the chain at entry and must not establish one,
    // which `finalizeChain` enforces from its own `stateful` guard.
    this.finalizeChain(completed, totalStepCount, stateful);
    return { response: completed };
  }

  private createManualBackgroundError(message: string, cause?: unknown): Error {
    const error: Error & { provider?: string } = new Error(
      message,
      cause === undefined ? undefined : { cause },
    );
    // Synthetic lifecycle errors have no SDK instance for sdkErrorTagger to map.
    error.provider = this.config.provider;
    attachManualRetryOnlyError(error);
    return error;
  }

  private createBackgroundTimeoutError(interactionId: string): Error {
    return this.createManualBackgroundError(
      `Google Interactions background interaction ${interactionId} exceeded ` +
        `maximum polling duration of ${ModelHandlerGoogleInteractions.BACKGROUND_MAX_DURATION_MS} ms. ` +
        'Server-side cancellation was attempted; retry explicitly to start a new interaction.',
    );
  }

  /**
   * Classify a failed background retrieve (resume or poll — the policy is the
   * same on both paths). A definitively missing interaction (404/410, or the
   * provider-specific stale-id predicate) clears the pending id via a
   * manual-retry replacement error. Every other retrieval failure retains the
   * known id and rethrows the original: retryable transport, 408/409/429, and
   * 5xx failures can resume it automatically; non-missing 4xx and unknown
   * failures fail closed under the existing retry policy.
   */
  private classifyBackgroundRetrieveFailure(
    error: unknown,
    interactionId: string,
  ): BackgroundRetrieveFailureVerdict {
    const status = detectStatusCode(error);
    if (
      status === 404 ||
      status === 410 ||
      isStaleInteractionChainError(error)
    ) {
      return {
        action: 'replace',
        error: this.createManualBackgroundError(
          `Google Interactions background interaction ${interactionId} is no longer available` +
            `${status === undefined ? '' : ` (HTTP ${status})`}. ` +
            'Retry explicitly to start a new interaction.',
          error,
        ),
      };
    }
    return { action: 'retain' };
  }

  /**
   * Terminal-verdict hook for the shared lifecycle: known failure statuses
   * drop the pending id and throw a manual-retry error. The SDK status union
   * is open, so an unrecognized value does not prove the remote job is
   * terminal — retain its identity and fail closed.
   */
  private backgroundTerminalVerdict(
    polled: GoogleGenAIInteraction,
    interactionId: string,
    stats: BackgroundPollStats | undefined,
  ): BackgroundTerminalVerdict {
    const status = polled.status ?? 'unknown';
    this.logger.error(
      'Background interaction ended with a non-completed status.',
      {
        data: {
          interactionId,
          status,
          pollCount: stats?.pollCount,
          elapsedMs: stats?.elapsedMs,
        },
      },
    );

    if (
      ModelHandlerGoogleInteractions.BACKGROUND_FAILURE_STATUSES.includes(
        status as InteractionStatus,
      )
    ) {
      return {
        clearPending: true,
        error: this.createManualBackgroundError(
          `Google Interactions background interaction ${interactionId} ended with ` +
            `status "${status}". Retry explicitly to start a new interaction.`,
        ),
      };
    }

    return {
      clearPending: false,
      error: this.createManualBackgroundError(
        `Google Interactions background interaction ${interactionId} returned ` +
          `unknown status "${status}"; refusing to submit a replacement.`,
      ),
    };
  }

  /** Cancel the in-flight background interaction (best-effort; swallow errors). */
  private async cancelBackgroundInteraction(
    client: GoogleGenAI,
    interactionId: string,
  ): Promise<void> {
    try {
      // SMOKE-TEST: confirm cancel(id) transitions an in_progress interaction to
      // `cancelled` and a subsequent get reflects it (verify on a real-key run).
      await client.interactions.cancel(
        interactionId,
        undefined,
        this.interactionsRequestOptions(),
      );
      this.logger.debug(`Cancelled background interaction ${interactionId}.`);
    } catch (err) {
      this.logger.warn(
        `Failed to cancel background interaction ${interactionId}.`,
        { data: err },
      );
    }
  }

  /**
   * Client-side conversation compaction (system-prompt-swap summarization) via
   * the shared {@link ModelHandler.runClientCompaction} scaffold. Mirrors the
   * other handlers: summarize the conversation body through a stateless
   * Interactions request and replace it with a single user summary step.
   */
  private async compactConversation(
    client: GoogleGenAI,
    messages: Step[],
    tokensBefore: number,
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<{ compactedMessages: Step[]; didCompact: boolean }> {
    return this.runClientCompaction(
      messages,
      tokensBefore,
      async (conversationMessages, compactionSystemPrompt) => {
        const transcript = this.stepsToTextTranscript(conversationMessages);
        const summary = await client.interactions.create(
          {
            model: this.config.fullName,
            input: [
              {
                type: 'user_input',
                content: [
                  this.textMedia(`${compactionSystemPrompt}\n\n${transcript}`),
                ],
              },
            ],
            store: false,
            stream: false,
            ...(systemPrompt ? { system_instruction: systemPrompt } : {}),
            generation_config: {
              max_output_tokens: CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
            },
          },
          this.interactionsRequestOptions(signal),
        );
        return {
          summaryText: rawModelOutputText(summary).trim(),
          outputTokens:
            summary.usage?.total_output_tokens ??
            CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
        };
      },
      (summary): Step => ({
        type: 'user_input',
        content: [this.textMedia(summary)],
      }),
    );
  }

  /**
   * Consume the SSE event stream, routing deltas to the output / thinking
   * streams and tool-argument buffers, then assemble the finalized response.
   */
  private async consumeStream(
    stream: Stream<InteractionSSEEvent>,
    endTag: string | undefined,
    onOutputText: (text: string) => void,
  ): Promise<CreateResponseResult<GoogleGenAIInteraction, Step>> {
    const output = this.createOutputStream();
    const thinking = this.createThinkingStream();
    let streamsFinalized = false;

    try {
      const pending = new Map<number, PendingStepBuffer>();
      let completedInteraction: GoogleGenAIInteraction | undefined;
      let runningUsage: Usage | undefined;
      let interactionId: string | undefined;

      for await (const event of stream) {
        switch (event.event_type) {
          case 'interaction.created':
            interactionId = event.interaction.id;
            this.logger.debug(`Interaction created: ${interactionId}`);
            break;

          case 'step.start':
            pending.set(event.index, this.seedPendingStep(event.step));
            break;

          case 'step.delta': {
            const slot = pending.get(event.index) ?? this.seedPendingStep();
            pending.set(event.index, slot);
            this.applyDelta(slot, event.delta, output, thinking, onOutputText);
            if (event.metadata?.total_usage) {
              runningUsage = event.metadata.total_usage;
            }
            break;
          }

          case 'step.stop': {
            // argsBuffer only ever accumulates via `arguments_delta`, which is
            // exclusive to function_call steps — its presence is itself the
            // "this is a function call" signal, so no separate kind check is
            // needed here.
            const slot = pending.get(event.index);
            if (slot?.argsBuffer) {
              slot.args = parseToolInputAsObject(
                slot.argsBuffer,
                slot.callId ?? 'unknown',
                this.logger,
              );
            }
            break;
          }

          case 'interaction.status_update':
            this.logger.debug(`Interaction status: ${event.status}`);
            break;

          case 'interaction.completed':
            // The completed event's `interaction` field is already structurally
            // compatible with GoogleGenAIInteraction (same required id/status,
            // same optional usage/steps), so no cast is needed here.
            completedInteraction = event.interaction;
            break;

          case 'error': {
            const message = event.error?.message ?? 'Interactions stream error';
            const err = new Error(message);
            this.sdkErrorTagger(err, this.config.provider);
            throw err;
          }
        }
      }

      // Assemble the finalized step list from the per-index accumulators so that
      // thought signatures + function calls round-trip verbatim next round.
      const finalizedSteps = this.finalizeSteps(pending);

      const usage = completedInteraction?.usage ?? runningUsage ?? undefined;
      // If the stream ended without an interaction.completed (or error) event the
      // turn was truncated/abnormally cut — report `incomplete` (not `completed`)
      // so the cycle can continue rather than silently treating partial output as
      // done. `finalizeSteps` preferred over the server steps so streamed thought
      // signatures survive the round-trip.
      let status = completedInteraction?.status;
      if (!status) {
        this.logger.warn(
          'Google Interactions stream ended without an interaction.completed event; treating as incomplete.',
        );
        status = 'incomplete';
      }

      const response: GoogleGenAIInteraction = {
        ...(completedInteraction ?? {}),
        id: completedInteraction?.id ?? interactionId ?? generateShortId(),
        status,
        usage,
        steps:
          finalizedSteps.length > 0
            ? finalizedSteps
            : (completedInteraction?.steps ?? []),
      };

      this.finalizeProgressStreams(
        thinking,
        output,
        response,
        () => this.extractResponse(response, endTag ?? '').text,
      );
      streamsFinalized = true;

      return { response };
    } finally {
      // Finalize the progress streams on a mid-stream failure so the progress
      // view does not hang in a loading state. Guarded so the success-path
      // finalize above (with the real content) is not overwritten.
      if (!streamsFinalized) {
        this.finalizeProgressStreamsOnError(thinking, output);
      }
    }
  }

  /**
   * Seed a fresh accumulator for a `step.start` event. The only up-front data
   * worth capturing is a function_call step's id/name (arguments stream in
   * later via `arguments_delta`, handled by {@link applyDelta}); every other
   * step kind starts empty and is categorized later in {@link finalizeSteps}.
   */
  private seedPendingStep(step?: Step): PendingStepBuffer {
    return step?.type === 'function_call'
      ? { callId: step.id, callName: step.name }
      : {};
  }

  private applyDelta(
    slot: PendingStepBuffer,
    delta: Interactions.StepDelta['delta'],
    output: ReturnType<ModelHandlerGoogleInteractions['createOutputStream']>,
    thinking: ReturnType<
      ModelHandlerGoogleInteractions['createThinkingStream']
    >,
    onOutputText: (text: string) => void,
  ): void {
    switch (delta.type) {
      case 'text':
        if (delta.text) {
          slot.text = (slot.text ?? '') + delta.text;
          output.append(delta.text);
          onOutputText(delta.text);
        }
        break;
      case 'thought_summary': {
        const text =
          delta.content && isTextContent(delta.content)
            ? delta.content.text
            : '';
        if (text) {
          slot.thought = (slot.thought ?? '') + text;
          thinking.append(text);
        }
        break;
      }
      case 'thought_signature':
        if (delta.signature) slot.signature = delta.signature;
        break;
      case 'arguments_delta':
        if (delta.arguments) {
          slot.argsBuffer = (slot.argsBuffer ?? '') + delta.arguments;
        }
        break;
      default:
        // Media / built-in tool deltas are ignored in v0 (no media-out, no
        // built-in tools). Captured here so the switch stays exhaustive-by-intent.
        break;
    }
  }

  /** Turn the per-index accumulators into a verbatim model-generated Step[]. */
  private finalizeSteps(pending: Map<number, PendingStepBuffer>): Step[] {
    const ordered = [...pending.entries()].toSorted((a, b) => a[0] - b[0]);
    const steps: Step[] = [];
    for (const [, slot] of ordered) {
      // Derive the step's kind ONCE from which raw fields actually
      // accumulated data, instead of the old approach of mutating a `.type`
      // tag as each delta arrived. Precedence — thought, then function_call,
      // then model_output text — mirrors the branch order the mutation-based
      // version checked in, and is safe because the Interactions SSE
      // contract never mixes delta families within one step index: a thought
      // step only ever receives thought_summary/thought_signature deltas, a
      // function_call step only arguments_delta (plus its id/name seeded at
      // step.start), and a model_output step only text — so at most one of
      // these signal groups is ever populated for a given index.
      if (slot.signature || slot.thought) {
        const step = this.thoughtStep(slot.signature, slot.thought);
        if (step) steps.push(step);
      } else if (slot.callId || slot.callName || slot.argsBuffer || slot.args) {
        steps.push({
          type: 'function_call',
          id: slot.callId ?? generateShortId(),
          name: slot.callName ?? '',
          arguments:
            slot.args ??
            parseToolInputAsObject(
              slot.argsBuffer ?? '',
              slot.callId ?? 'unknown',
              this.logger,
            ),
        } satisfies FunctionCallStep);
      } else if (slot.text) {
        steps.push({
          type: 'model_output',
          content: [{ type: 'text', text: slot.text }],
        } satisfies ModelOutputStep);
      }
    }
    return steps;
  }

  // ===========================================================================
  // Request building helpers
  // ===========================================================================

  // No temperature: the Interactions generation_config has no such field (the
  // chat GenerateContentConfig still does). Sampling temperature is not
  // configurable on this wire, so callers' values are ignored here rather than
  // sent and silently dropped by the API.
  private buildGenerationConfig(endTag?: string): GenerationConfig {
    const generationConfig: GenerationConfig = {
      max_output_tokens: this.getEffectiveMaxOutputTokens(),
      ...(endTag ? { stop_sequences: [endTag] } : {}),
    };
    if (this.capabilities.supportsReasoning) {
      const thinkingLevel = this.getThinkingLevel();
      if (thinkingLevel) generationConfig.thinking_level = thinkingLevel;
      generationConfig.thinking_summaries = 'auto';
    }
    return generationConfig;
  }

  /**
   * Convert generic tool definitions to Interactions `FunctionT[]`.
   *
   * Generates Google's finite OpenAPI schema and feeds it directly into
   * `FunctionT.parameters` — the
   * chat `toGoogleTools` wrapper (`[{ functionDeclarations }]`) is NOT reused.
   */
  private toInteractionsTools(defs: ToolDefinition[]): FunctionT[] {
    return defs.map((d): FunctionT => ({
      type: 'function',
      name: d.name,
      description: d.description,
      parameters: convertGoogleToolSchema(d) ?? undefined,
    }));
  }
}
