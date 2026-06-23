// Standard library imports
import { Buffer } from 'node:buffer';

// Third-party imports
import { nanoid } from 'nanoid';
import {
  GoogleGenAI,
  createPartFromText,
  createUserContent,
  type File,
  type Interactions,
  type Stream,
} from '@google/genai';

// Local imports - agent
import { ReasoningEffort } from 'llm-zoo';
import { logSdkError } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { hasEndTag } from '@agent/core/definition/AgentDataclass';
import type { AgentSetting } from '@agent/core/definition/AgentDataclass';
import type { AgentWorkspaceState } from '@agent/core/execution/AgentWorkspaceState';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import { K_SLICE } from '@agent/core/constants';
import {
  getSdkErrorMessage,
  attachPartialText,
  takeTail,
  PARTIAL_TEXT_TAIL_MAX,
} from '@common/errors/sdkErrorUtils';
import type { ToolDefinition } from '@model';
import replacementEngine from '@replacement/engine';

// Local imports - tools
import type { FileLocation } from '@shared/schemas';
import type { ToolFileAttachment } from '@shared/schemas/toolResult';

// Local imports - utils
import { isNonEmptyString } from '@utils/core';
import { flexibleFS, getShortDisplayPath } from '@utils/files';
import { joinNonEmpty, pluralize } from '@utils/text/stringUtils';

// Local file imports
import {
  computeGoogleInteractionsPrice,
  normalizeGoogleInteractionsUsage,
} from './googleInteractionsUsage';
import { prepareExistingOutputContent } from '../utils/fileContentUtils';
import { tagGoogleSdkError } from './googleSdkError';
import {
  DEFAULT_ATTACHMENT_MIME_TYPE,
  formatAttachmentSummary,
  formatToolResultAsText,
  loadAttachmentBuffer,
  type ToolResultPayload,
} from '../utils/toolAttachmentUtils';
import { convertToolSchema } from '../toolConversion';
import type { GooglePricingConfig } from './googleUsage';

// Type imports
import type { MediaFileResult } from '../support/MediaAttachmentProcessor';
import type { ProviderStopReason } from '../types/StopReasonTypes';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  GoogleToolCall,
  TokenCountOptions,
} from '../types/IModelHandler';

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
// The SDK's own `GoogleGenAIInteraction` (the wrapped non-streaming response)
// is an internal `declare type` and is NOT re-exported, so we reconstruct its
// public shape: the `Interaction` body with `steps` made non-optional (the SDK
// override). The handler only reads `status`/`usage`/`steps`, which both the
// non-streaming response and the SSE `interaction.completed` event expose.
type GoogleGenAIInteraction = Omit<Interactions.Interaction, 'steps'> & {
  steps?: Step[];
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

/** Mutable accumulator for a single in-flight step during streaming. */
interface PendingStep {
  type: Step['type'] | string;
  /** model_output text accumulator */
  text: string;
  /** thought summary accumulator */
  thought: string;
  /** thought signature, captured from ThoughtSignatureDelta */
  signature?: string;
  /** function_call fields */
  callId?: string;
  callName?: string;
  /** concatenated arguments_delta fragments, parsed at step.stop */
  argsBuffer: string;
  /** parsed arguments after step.stop */
  args?: Record<string, unknown>;
}

/**
 * Handler for Google models using the @google/genai Interactions API.
 *
 * Additive sibling to {@link ModelHandlerGoogleGenAI} (chat / generateContent),
 * shipped behind the `texra.model.useGoogleInteractionsAPI` flag (default off).
 *
 * v0 is STATELESS (`store: false`): the local transcript is kept as a verbatim
 * `Step[]` and resent in full each round (no `previous_interaction_id`), with
 * request-level `system_instruction` / `tools` / `generation_config` resent on
 * every `create`. Thought-step signatures are round-tripped verbatim across
 * TOOL turns (the function-calling chain that requires them — see
 * {@link buildAssistantTurnSteps}, spec §6.1-§6.2).
 *
 * Known v0 limitation (parity with {@link ModelHandlerGoogleGenAI}): a TERMINAL
 * turn (model emits text with no tool call) is recorded via the base
 * `createAssistantMessageFromResponse`, which yields a text-only `model_output`
 * step — the trailing thought signature is not preserved. Gemini only requires
 * signatures within an in-flight function-calling sequence, so this is safe; a
 * fuller fix would need the base contract to return `Step[]` (out of scope).
 */
export class ModelHandlerGoogleInteractions extends ModelHandler<
  Step,
  Usage | null,
  Usage,
  GoogleToolCall,
  GoogleGenAI,
  GoogleGenAIInteraction
> {
  private static readonly INLINE_MEDIA_LIMIT_BYTES = 20 * 1024 * 1024;

  private googleClient: GoogleGenAI | null = null;

  // ===========================================================================
  // Capability getters / auth (REUSE / PORT from the chat handler)
  // ===========================================================================

  private supportsFileUploads(): boolean {
    return (
      this.capabilities.supportsVision || this.capabilities.supportsNativeAudio
    );
  }

  private isGemini3Model(): boolean {
    return /^gemini-3[\.\-]/.test(this.config.fullName);
  }

  private getMediaResolution(mimeType: string): MediaResolution | undefined {
    if (!this.isGemini3Model()) return undefined;
    if (mimeType.startsWith('image/')) return 'high';
    // Interactions DocumentContent currently has no resolution field, so PDF
    // resolution cannot mirror generateContent until the SDK exposes it.
    return undefined;
  }

  private mediaResolutionFields(mimeType: string): {
    resolution?: MediaResolution;
  } {
    const resolution = this.getMediaResolution(mimeType);
    return resolution ? { resolution } : {};
  }

  /**
   * Map the model's reasoning effort to an Interactions `thinking_level`.
   * Mirrors the chat handler's `getThinkingLevel`, but emits the Interactions
   * `GenerationConfig.thinking_level` lowercase literals.
   */
  private getThinkingLevel(): ThinkingLevel | undefined {
    const requestedLevel = this.capabilities.reasoningEffort;
    const isGemini3 = this.isGemini3Model();

    switch (requestedLevel) {
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
        // Gemini 3 Pro only supports low/high; medium falls back to high for Pro.
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

  protected getInlineUploadLimitBytes(): number {
    return ModelHandlerGoogleInteractions.INLINE_MEDIA_LIMIT_BYTES;
  }

  async getClient(): Promise<GoogleGenAI> {
    // When using server-side relay keys, always create a fresh client to ensure
    // auth tokens are refreshed (tokens expire every ~30 mins). Personal API
    // keys don't expire, so caching is safe for those. (REUSE: identical to the
    // chat handler; `apiVersion` left unset for v0 — see spec §6.4.)
    if (this.shouldUseServerSideKeys()) {
      const credential = await this.getApiKey();
      const baseUrl = this.getBaseUrl();
      this.logger.debug(
        `Using Google GenAI Interactions SDK with relay auth. Base URL: ${baseUrl}`,
      );
      return new GoogleGenAI({
        apiKey: credential,
        httpOptions: {
          baseUrl: baseUrl ?? undefined,
          retryOptions: { attempts: 1 },
        },
      });
    }

    if (!this.googleClient) {
      const credential = await this.getApiKey();
      const baseUrl = this.getBaseUrl();
      this.logger.debug(
        `Using Google GenAI Interactions SDK. Base URL: ${baseUrl}`,
      );
      this.googleClient = new GoogleGenAI({
        apiKey: credential,
        httpOptions: {
          baseUrl: baseUrl ?? undefined,
          retryOptions: { attempts: 1 },
        },
      });
    }
    return this.googleClient;
  }

  override get supportsTokenCounting(): boolean {
    return this.capabilities.supportsTokenCounting;
  }

  /**
   * Group parallel tool calls into one follow-up so the stateless round-trip
   * resends the model-generated steps (thought steps with their signatures +
   * all function-call steps) verbatim ahead of the function_result steps, in
   * the order the model emitted them. The tool-use flow only records the
   * assistant turn through the follow-up methods (see `ToolUseDispatchNode`),
   * so — exactly like the chat handler — they must rebuild it; otherwise the
   * function_result's `call_id` would reference a call absent from `input`
   * and the thought signature would be lost (spec §6.1).
   */
  override get requiresBatchedParallelToolResults(): boolean {
    return true;
  }

  protected override get sdkErrorTagger() {
    return tagGoogleSdkError;
  }

  // ===========================================================================
  // Token counting (REUSE — countTokens is unchanged in Interactions)
  // ===========================================================================

  override async estimateTokenCount(
    messages: Step[],
    options?: TokenCountOptions<GoogleGenAI>,
  ): Promise<number> {
    const client = options?.client ?? (await this.getClient());

    // Token counting stays on the chat `countTokens` endpoint, which takes a
    // `Content[]`. Flatten the step transcript into countable text Content so
    // the pre-flight count is independent of the Interactions wire format.
    const countContents = [];
    if (options?.systemPrompt) {
      countContents.push({
        role: 'system',
        parts: [createPartFromText(options.systemPrompt)],
      });
    }
    const transcriptText = this.stepsToCountableText(messages);
    if (transcriptText) {
      countContents.push(createUserContent(transcriptText));
    }

    const responseTokenCount = await client.models.countTokens({
      model: this.config.fullName,
      contents: countContents,
      config: { abortSignal: options?.signal },
    });

    const totalTokens = responseTokenCount.totalTokens ?? 0;
    this.logger.debug(`Token count of message: ${totalTokens}`);
    return totalTokens;
  }

  /** Flatten the step transcript to plain text for the countTokens estimate. */
  private stepsToCountableText(steps: Step[]): string {
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
      }
    }
    return joinNonEmpty(chunks, '\n') ?? '';
  }

  // ===========================================================================
  // Usage / price (PORT — delegate to the snake_case adapter)
  // ===========================================================================

  computePrice(responseUsage: Usage | null): number {
    return computeGoogleInteractionsPrice(responseUsage, this.pricingConfig());
  }

  private pricingConfig(): GooglePricingConfig {
    return {
      inputPrice: this.config.inputPrice,
      outputPrice: this.config.outputPrice,
      cacheDiscountFactor: this.capabilities.cacheDiscountFactor,
    };
  }

  normalizeUsage(
    rawUsage: Usage | null,
    responseTimeMs: number,
  ): NormalizedUsage {
    return normalizeGoogleInteractionsUsage(
      rawUsage,
      responseTimeMs,
      this.pricingConfig(),
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
    const content: Content[] = [this.textContent(userPrefix)];

    if (mediaFiles?.length && this.supportsFileUploads()) {
      const media = await this.createMediaMessage(mediaFiles);
      if (media.length > 0) {
        const label = mediaFiles
          .map((loc) => getShortDisplayPath(loc))
          .join(', ');
        content.push(
          this.textContent(
            `\nAttached ${pluralize(mediaFiles.length, 'file')}: ${label}`,
          ),
        );
        content.push(...media);
      }
    }

    content.push(this.textContent(`\n${userRequest}`));

    return [{ type: 'user_input', content } satisfies UserInputStep];
  }

  async createRoundMessages(
    messages: Step[],
    userMessage: string,
    mediaFiles?: FileLocation[],
  ): Promise<Step[]> {
    const content: Content[] = [];

    if (mediaFiles?.length && this.supportsFileUploads()) {
      const media = await this.createMediaMessage(mediaFiles);
      if (media.length > 0) {
        const label = mediaFiles
          .map((loc) => getShortDisplayPath(loc))
          .join(', ');
        content.push(
          this.textContent(
            `\nProcessing ${pluralize(mediaFiles.length, 'file')}: ${label}`,
          ),
        );
        content.push(...media);
      }
    }

    content.push(this.textContent(userMessage));

    messages.push({ type: 'user_input', content } satisfies UserInputStep);
    return messages;
  }

  async createUserFollowUpMessages(
    messages: Step[],
    userMessage: string,
  ): Promise<Step[]> {
    const last = messages.at(-1);
    if (last?.type === 'user_input') {
      (last.content ??= []).push(this.textContent(userMessage));
    } else {
      messages.push({
        type: 'user_input',
        content: [this.textContent(userMessage)],
      } satisfies UserInputStep);
    }
    return messages;
  }

  createAssistantMessage(text: string): Step {
    return {
      type: 'model_output',
      content: [this.textContent(text)],
    } satisfies ModelOutputStep;
  }

  override extractAssistantText(message: Step): string | undefined {
    if (message.type !== 'model_output') return undefined;
    return joinNonEmpty(
      (message.content ?? []).filter(isTextContent).map((c) => c.text),
    );
  }

  override async createMediaMessage(
    mediaFiles: FileLocation[],
  ): Promise<Content[]> {
    if (!mediaFiles?.length || !this.supportsFileUploads()) {
      return [];
    }
    const { entries, results } =
      await this.mediaProcessor.loadEntries(mediaFiles);
    this.mediaProcessor.logResults(results);
    if (entries.length === 0) return [];
    return this.uploadMediaEntries(entries);
  }

  createMediaContent(mediaMessage: MediaEntry[]): MediaEntry[] {
    // Interactions handles media entries via uploadMediaEntries; identity here
    // matches the chat handler's REUSE of createMediaContent.
    return mediaMessage;
  }

  /** Build typed Content for media entries (inline ≤20 MB; uploaded uri otherwise). */
  private async uploadMediaEntries(entries: MediaEntry[]): Promise<Content[]> {
    if (entries.length === 0) return [];

    const client = await this.getClient();
    const out: Content[] = [];
    const summaries: MediaFileResult[] = [];
    const failures: string[] = [];
    const inlineLimit = this.getInlineUploadLimitBytes();

    for (const entry of entries) {
      const fileName = entry.file_name ?? 'unnamed-file';
      const mimeType = entry.media_type ?? DEFAULT_ATTACHMENT_MIME_TYPE;
      const inlinePayload = isNonEmptyString(entry.data) ? entry.data : null;

      if (inlinePayload) {
        const payloadBytes = Buffer.byteLength(inlinePayload, 'base64');
        if (payloadBytes <= inlineLimit) {
          this.logger.debug(
            `Attaching media entry ${fileName} inline (${payloadBytes} bytes).`,
          );
          out.push(this.inlineMediaContent(inlinePayload, mimeType));
          summaries.push({ path: fileName, ok: true });
          continue;
        }
        this.logger.debug(
          `Media entry ${fileName} is ${payloadBytes} bytes which exceeds inline limit of ${inlineLimit}. Falling back to upload.`,
        );
      }

      const canUseSourcePath =
        entry.source_path &&
        entry.source_path.length > 0 &&
        entry.bytes_match_source !== false;
      if (!canUseSourcePath) {
        this.logger.error(
          `Skipping media entry ${fileName} due to missing upload source`,
        );
        summaries.push({ path: fileName, ok: false });
        continue;
      }

      try {
        const uploadPath = entry.source_path as string;
        this.logger.debug(
          `Uploading media entry ${fileName} via Google GenAI SDK from path ${uploadPath}`,
        );
        const uploaded: File = await client.files.upload({
          file: uploadPath,
          config: { mimeType, displayName: fileName },
        });
        const fileUri = uploaded.uri;
        if (!fileUri) {
          this.logger.error(
            `Upload result for ${fileName} is missing a URI. Skipping entry.`,
          );
          summaries.push({ path: fileName, ok: false });
          continue;
        }
        const resolvedMimeType =
          uploaded.mimeType || entry.media_type || DEFAULT_ATTACHMENT_MIME_TYPE;
        out.push(this.uriMediaContent(fileUri, resolvedMimeType));
        summaries.push({ path: fileName, ok: true });
      } catch (error) {
        summaries.push({ path: fileName, ok: false });
        failures.push(`${fileName}: ${getSdkErrorMessage(error)}`);
      }
    }

    if (summaries.some((s) => !s.ok)) {
      this.logger.warn(
        'Some media files failed to upload via Google GenAI SDK' +
          (failures.length > 0 ? `: ${failures.join('; ')}` : ''),
      );
    }
    return out;
  }

  private textContent(text: string): TextContent {
    return { type: 'text', text };
  }

  private inlineMediaContent(data: string, mimeType: string): Content {
    if (mimeType.startsWith('image/')) {
      return {
        type: 'image',
        data,
        mime_type: mimeType,
        ...this.mediaResolutionFields(mimeType),
      } satisfies ImageContent;
    }
    if (mimeType.startsWith('audio/')) {
      return {
        type: 'audio',
        data,
        mime_type: mimeType,
      } satisfies AudioContent;
    }
    if (mimeType.startsWith('video/')) {
      return {
        type: 'video',
        data,
        mime_type: mimeType,
      } satisfies VideoContent;
    }
    return {
      type: 'document',
      data,
      mime_type: mimeType,
    } satisfies DocumentContent;
  }

  private uriMediaContent(uri: string, mimeType: string): Content {
    if (mimeType.startsWith('image/')) {
      return {
        type: 'image',
        uri,
        mime_type: mimeType,
        ...this.mediaResolutionFields(mimeType),
      } satisfies ImageContent;
    }
    if (mimeType.startsWith('audio/')) {
      return {
        type: 'audio',
        uri,
        mime_type: mimeType,
      } satisfies AudioContent;
    }
    if (mimeType.startsWith('video/')) {
      return {
        type: 'video',
        uri,
        mime_type: mimeType,
      } satisfies VideoContent;
    }
    return {
      type: 'document',
      uri,
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

    const steps = responseObject.steps ?? [];
    const rawText = steps
      .filter((s): s is ModelOutputStep => s.type === 'model_output')
      .flatMap((s) =>
        (s.content ?? []).filter(isTextContent).map((c) => c.text),
      )
      .join('');

    let responseText = replacementEngine.applyAll(rawText);
    const usage = responseObject.usage;
    const stopReason: ProviderStopReason = responseObject.status ?? 'completed';

    // If the model completed naturally without the end tag, append it (mirrors
    // the chat handler's STOP behavior, keyed on the terminal `completed` status).
    if (
      stopReason === 'completed' &&
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

    const thoughtContent = thoughtSteps
      .map((s) =>
        (s.summary ?? [])
          .filter(isTextContent)
          .map((c) => c.text)
          .join(''),
      )
      .join('')
      .trim();

    if (workspaceState && !workspaceState.reasoning.thinkingAdded) {
      workspaceState.reasoning.thinkingBlocks = thoughtSteps.map((s) => ({
        type: 'thinking',
        thinking: (s.summary ?? [])
          .filter(isTextContent)
          .map((c) => c.text)
          .join(''),
        signature: s.signature,
      }));
      workspaceState.reasoning.thinkingAdded = true;
    }

    if (thoughtContent) {
      this.logger.debug(
        `Google Interactions thought summary preview: ${thoughtContent.slice(0, K_SLICE)}...`,
      );
    }
    return thoughtContent || null;
  }

  extractToolUse(responseObject: GoogleGenAIInteraction): GoogleToolCall[] {
    const steps = responseObject?.steps ?? [];
    const results: GoogleToolCall[] = [];
    for (const step of steps) {
      if (step.type !== 'function_call') continue;
      results.push({
        provider: 'google',
        callId: step.id ?? nanoid(),
        name: step.name,
        input: step.arguments,
        // GoogleToolCall.raw is a chat `FunctionCall`; reconstruct the shape the
        // downstream code reads (name/args/id) from the Interactions step.
        raw: { id: step.id, name: step.name, args: step.arguments },
      });
    }
    return results;
  }

  // ===========================================================================
  // Stop / continue (PORT — keyed on Interaction status, not FinishReason)
  // ===========================================================================

  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    // "incomplete" is the Interactions truncation status (analogous to chat's
    // MAX_TOKENS): the response was cut short by the output budget.
    const truncated = stopReason === 'incomplete';
    const containsEndTag = hasEndTag(agentSetting, newResponse);

    if (truncated && !containsEndTag) {
      this.logger.debug(
        `Should continue: incomplete status and end tag '${agentSetting.endTag}' is missing.`,
      );
      return true;
    }
    this.logger.debug(
      `Should not continue: StopReason='${stopReason}', HasEndTag='${containsEndTag}'.`,
    );
    return false;
  }

  addContinueMessageWithPrefill(
    _messages: Step[],
    _workspaceState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
  ): void {
    this.logger.debug(
      "Interactions handler does not support assistant prefill continuation. Using 'WithoutPrefill'.",
    );
  }

  addContinueMessageWithoutPrefill(
    messages: Step[],
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
  ): void {
    const prompt = this.createContinuationPrompt(workspaceState, agentSetting);
    this.logger.debug('Adding continuation message.');
    messages.push({
      type: 'user_input',
      content: [this.textContent(prompt)],
    } satisfies UserInputStep);
  }

  updateMessageContentWithPrefill(
    _messages: Step[],
    _bestConnector: string,
    _newResponse: string,
    _workspaceState: AgentWorkspaceState,
  ): void {
    this.logger.debug(
      "Interactions handler does not support assistant prefill update. Using 'WithoutPrefill'.",
    );
  }

  updateMessageContentWithoutPrefill(
    messages: Step[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    this.logger.debug(
      'Updating message history for Google Interactions (no prefill).',
    );

    const last = messages.at(-1);
    if (
      last?.type === 'user_input' &&
      this.containCutOffMessage(
        (last.content ?? [])
          .filter(isTextContent)
          .map((c) => c.text)
          .join(''),
      )
    ) {
      messages.pop();
      this.logger.debug('Removed user continuation prompt.');
    }

    const modelStep = messages.at(-1);
    if (modelStep?.type === 'model_output') {
      const content = (modelStep.content ??= []);
      const lastText = [...content].reverse().find(isTextContent);
      if (lastText) {
        lastText.text = (lastText.text ?? '') + bestConnector + newResponse;
      } else {
        content.push(this.textContent(bestConnector + newResponse));
        this.logger.warn(
          'Added new text content to last model_output step as none existed.',
        );
      }
    } else {
      this.logger.debug('Adding new model_output step for the response.');
      messages.push(
        this.createAssistantMessage(workspaceState.assembly.accumulatedOutput),
      );
    }
  }

  async initializeOutputAndPrefill(
    _agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: Step[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
    prefill: string,
  ): Promise<[boolean, Step[]]> {
    this.logger.debug(
      `Initializing output and prefill for ${outputLocation.absolutePath}. Prefill content: "${prefill.slice(0, 100)}..."`,
    );

    if (!(await flexibleFS.existsAndNonTrivial(outputLocation))) {
      this.logger.debug(
        `Output file ${outputLocation.absolutePath} does not exist or is empty.`,
      );
      workspaceState.assembly.accumulatedOutput = prefill;

      if (prefill.length === 0) {
        this.logger.debug(
          'No prefill provided; skipping pseudo-prefill instruction',
        );
        return [false, messages];
      }

      // Pseudo-prefill: Interactions has no assistant-prefill, so carry the
      // intended start as a user_input step (mirrors the chat handler).
      const pseudoPrefillMsg = `Organize your response with XML tags. Start your response with:\n${prefill}`;
      const last = messages.at(-1);
      if (last?.type === 'user_input') {
        (last.content ??= []).push(this.textContent(pseudoPrefillMsg));
      } else {
        messages.push({
          type: 'user_input',
          content: [this.textContent(pseudoPrefillMsg)],
        } satisfies UserInputStep);
      }
      this.logger.debug(`Added pseudo-prefill message: "${pseudoPrefillMsg}"`);
      return [false, messages];
    }

    this.logger.debug(
      `Output file ${outputLocation.absolutePath} exists and is non-trivial. Reading content.`,
    );

    const { fileContent } = await prepareExistingOutputContent(
      outputLocation,
      workspaceState,
      this.logger,
    );

    messages.push(this.createAssistantMessage(fileContent));
    this.logger.debug(`Added existing file content as a model_output step.`);

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug(
        'End tag detected in existing file content - skipping generation.',
      );
      return [true, messages];
    }

    this.logger.debug(
      'Existing file content found without end tag - continuing generation.',
    );
    this.addContinueMessageWithoutPrefill(
      messages,
      workspaceState,
      agentSetting,
    );
    return [false, messages];
  }

  // ===========================================================================
  // Tool round-trip (REWRITE — verbatim Step[] + a function_result step)
  // ===========================================================================

  async createToolUseFollowUpMessages(
    _client: GoogleGenAI | undefined,
    call: GoogleToolCall,
    result: ToolResultPayload,
    attachments: ToolFileAttachment[],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<Step[]> {
    if (!call.callId) {
      throw new Error('Function call id is required for follow-up messages');
    }

    // Rebuild the model-generated turn (thoughts + the function-call step) so the
    // stateless round-trip resends it verbatim before the local result step —
    // the flow records the assistant turn only through this return value. Read
    // reasoning BEFORE resetting it.
    const assistantSteps = this.buildAssistantTurnSteps(
      [call],
      workspaceState,
      text,
    );
    const resultStep = await this.buildFunctionResultStep(
      call,
      result,
      attachments,
    );

    // Reset ephemeral state after consumption (matches the chat/Anthropic pattern).
    if (workspaceState) {
      workspaceState.resetServerToolContent();
      workspaceState.resetReasoning();
    }

    return [...assistantSteps, resultStep];
  }

  /**
   * Follow-up for MULTIPLE parallel tool calls. All model-generated steps
   * (thoughts + every function-call step) are emitted together in model-emitted
   * order, followed by every function_result step — mirroring the chat handler's
   * batched path, re-expressed as Interactions `Step[]` (spec §6.1).
   */
  async createBatchedToolUseFollowUpMessages(
    calls: GoogleToolCall[],
    results: ToolResultPayload[],
    attachmentsPerCall: ToolFileAttachment[][],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<Step[]> {
    if (calls.length === 0) return [];
    if (calls.length !== results.length) {
      throw new Error(
        `Mismatched calls and results: ${calls.length} calls, ${results.length} results`,
      );
    }
    if (calls.length !== attachmentsPerCall.length) {
      throw new Error(
        `Mismatched calls and attachments: ${calls.length} calls, ${attachmentsPerCall.length} attachment arrays`,
      );
    }
    for (const [index, call] of calls.entries()) {
      if (!call.callId) {
        throw new Error(
          `Function call at index ${index} (${call.name ?? 'unknown'}) is missing callId`,
        );
      }
    }

    const assistantSteps = this.buildAssistantTurnSteps(
      calls,
      workspaceState,
      text,
    );
    const resultSteps = await Promise.all(
      calls.map((call, i) =>
        this.buildFunctionResultStep(call, results[i], attachmentsPerCall[i]),
      ),
    );

    if (workspaceState) {
      workspaceState.resetServerToolContent();
      workspaceState.resetReasoning();
    }

    return [...assistantSteps, ...resultSteps];
  }

  /**
   * Reconstruct the model-generated steps of the just-finished turn: the
   * thought steps (carrying their signatures, sourced from the reasoning cache
   * populated by `processThinkingBlock`), optional assistant text, then the
   * function-call steps. Resent verbatim so the backend can validate reasoning
   * across tool turns under `store: false`.
   */
  private buildAssistantTurnSteps(
    calls: GoogleToolCall[],
    workspaceState: AgentWorkspaceState | undefined,
    text: string | undefined,
  ): Step[] {
    const steps: Step[] = [];

    for (const block of workspaceState?.reasoning.thinkingBlocks ?? []) {
      if (!block.signature && !block.thinking) continue;
      steps.push({
        type: 'thought',
        ...(block.signature ? { signature: block.signature } : {}),
        ...(block.thinking
          ? { summary: [{ type: 'text', text: block.thinking }] }
          : {}),
      } satisfies ThoughtStep);
    }

    if (text) {
      steps.push(this.createAssistantMessage(text));
    }

    for (const call of calls) {
      steps.push({
        type: 'function_call',
        id: call.callId ?? nanoid(),
        name: call.name ?? '',
        arguments: (call.input ?? {}) as Record<string, unknown>,
      } satisfies FunctionCallStep);
    }

    return steps;
  }

  /** Build a `function_result` step, embedding tool-result images inline. */
  private async buildFunctionResultStep(
    call: GoogleToolCall,
    result: ToolResultPayload,
    attachments: ToolFileAttachment[],
  ): Promise<FunctionResultStep> {
    const subcontent: FunctionResultSubcontent[] = [];
    let attachmentSummary: string | undefined;

    if (this.canProcessToolResultAttachments && attachments.length > 0) {
      attachmentSummary = formatAttachmentSummary(
        attachments,
        'included-inline',
      );
      const encoded = await Promise.all(
        attachments.map((a) => this.buildFunctionResultImage(a)),
      );
      for (const image of encoded) {
        if (image) subcontent.push(image);
      }
      if (subcontent.length === 0 && attachments.length > 0) {
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
      ...(result.isError ? { is_error: true } : {}),
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
      this.logger.warn(
        `Failed to encode attachment '${attachment.path}' for Interactions function result: ${getSdkErrorMessage(error)}`,
      );
      return null;
    }
  }

  /** Flatten a function-result payload's `result` field to plain text. */
  private functionResultToText(result: FunctionResultStep['result']): string {
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) {
      return result
        .filter(isTextContent)
        .map((c) => c.text)
        .join('');
    }
    return '';
  }

  // ===========================================================================
  // Message modification (post-build enrichment)
  // ===========================================================================

  prependTextToUserMessage(messages: Step[], text: string): void {
    if (!text.trim()) return;
    const lastUser = [...messages]
      .reverse()
      .find((s): s is UserInputStep => s.type === 'user_input');
    if (lastUser) {
      (lastUser.content ??= []).unshift(this.textContent(text));
    }
  }

  async addMediaToUserMessage(
    messages: Step[],
    mediaFiles: FileLocation[],
  ): Promise<void> {
    if (!mediaFiles.length || !this.supportsFileUploads()) return;
    const lastUser = [...messages]
      .reverse()
      .find((s): s is UserInputStep => s.type === 'user_input');
    if (!lastUser) return;
    try {
      const media = await this.createMediaMessage(mediaFiles);
      (lastUser.content ??= []).unshift(...media);
    } catch (err) {
      logSdkError(
        this.logger,
        `Error adding media to user message: ${getSdkErrorMessage(err)}`,
        err,
        { operation: 'add media to user message' },
      );
    }
  }

  // ===========================================================================
  // The streaming loop — createResponseImpl (REWRITE, the core)
  // ===========================================================================

  protected override async createResponseImpl(
    options: CreateResponseOptions<Step, GoogleGenAI>,
  ): Promise<CreateResponseResult<GoogleGenAIInteraction, Step>> {
    const {
      client,
      messages,
      temperature,
      systemPrompt,
      endTag,
      signal,
      tools,
    } = options;
    if (messages.length === 0) {
      this.logger.error('Cannot create response from empty messages array.');
      throw new Error('Messages array cannot be empty.');
    }

    const generationConfig = this.buildGenerationConfig(temperature, endTag);
    const interactionsTools = tools?.length
      ? this.toInteractionsTools(tools)
      : undefined;

    // Phase: COUNT + VALIDATE — adjust max_output_tokens to fit the context window.
    await this.applyTokenCountLimit({
      countTokens: () =>
        this.estimateTokenCount(messages, { client, systemPrompt, signal }),
      currentMaxTokens: generationConfig.max_output_tokens ?? 8192,
      contextWindow: this.config.contextWindow,
      detailLabel:
        'Google Interactions: max_output_tokens reduced to fit context window',
      applyReduced: (adjusted) => {
        generationConfig.max_output_tokens = adjusted;
      },
    });

    // v0 is stateless: resend the whole Step[] verbatim, no previous_interaction_id.
    const useStreaming = this.getStreamingConfig();
    let aggregatedText = '';

    try {
      if (useStreaming) {
        const params: CreateModelInteractionParamsStreaming = {
          model: this.config.fullName,
          input: messages,
          stream: true,
          store: false,
          ...(systemPrompt && { system_instruction: systemPrompt }),
          ...(interactionsTools && { tools: interactionsTools }),
          generation_config: generationConfig,
        };
        // Abort is wired via fetchOptions.signal (GoogleGenAIRequestOptions has
        // no top-level abortSignal field).
        const stream = (await client.interactions.create(
          params,
          signal ? { fetchOptions: { signal } } : undefined,
        )) as Stream<InteractionSSEEvent>;
        return await this.consumeStream(stream, endTag, (text) => {
          aggregatedText += text;
        });
      }

      const params: CreateModelInteractionParamsNonStreaming = {
        model: this.config.fullName,
        input: messages,
        stream: false,
        store: false,
        ...(systemPrompt && { system_instruction: systemPrompt }),
        ...(interactionsTools && { tools: interactionsTools }),
        generation_config: generationConfig,
      };
      const response = (await client.interactions.create(
        params,
        signal ? { fetchOptions: { signal } } : undefined,
      )) as unknown as GoogleGenAIInteraction;
      return { response };
    } catch (error) {
      if (aggregatedText) {
        attachPartialText(
          error,
          takeTail(aggregatedText, PARTIAL_TEXT_TAIL_MAX),
        );
      }
      throw error;
    }
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

    const pending = new Map<number, PendingStep>();
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
          const slot = pending.get(event.index);
          if (slot && slot.type === 'function_call' && slot.argsBuffer) {
            slot.args = this.parseArguments(slot.argsBuffer);
          }
          break;
        }

        case 'interaction.status_update':
          this.logger.debug(`Interaction status: ${event.status}`);
          break;

        case 'interaction.completed':
          // The completed event carries the final status/usage/steps. Cast to
          // the handler's Resp shape (steps non-optional downstream is tolerated
          // via the `?? []` reads in extractors).
          completedInteraction =
            event.interaction as unknown as GoogleGenAIInteraction;
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
    const status = completedInteraction?.status ?? 'completed';

    const response: GoogleGenAIInteraction = {
      ...(completedInteraction ?? {}),
      id: completedInteraction?.id ?? interactionId ?? nanoid(),
      status,
      usage,
      steps:
        finalizedSteps.length > 0
          ? finalizedSteps
          : (completedInteraction?.steps ?? []),
    } as unknown as GoogleGenAIInteraction;

    const finalReasoning = this.processThinkingBlock(response);
    thinking.finalize(finalReasoning ?? undefined);

    const finalText = this.extractResponse(response, endTag ?? '').text;
    output.finalize(finalText);

    return { response };
  }

  private seedPendingStep(step?: Step): PendingStep {
    return {
      type: step?.type ?? 'model_output',
      text: '',
      thought: '',
      argsBuffer: '',
      ...(step?.type === 'function_call'
        ? { callId: step.id, callName: step.name }
        : {}),
    };
  }

  private applyDelta(
    slot: PendingStep,
    delta: Interactions.StepDelta['delta'],
    output: ReturnType<ModelHandlerGoogleInteractions['createOutputStream']>,
    thinking: ReturnType<
      ModelHandlerGoogleInteractions['createThinkingStream']
    >,
    onOutputText: (text: string) => void,
  ): void {
    switch (delta.type) {
      case 'text':
        slot.type = 'model_output';
        if (delta.text) {
          slot.text += delta.text;
          output.append(delta.text);
          onOutputText(delta.text);
        }
        break;
      case 'thought_summary': {
        slot.type = 'thought';
        const text =
          delta.content && isTextContent(delta.content)
            ? delta.content.text
            : '';
        if (text) {
          slot.thought += text;
          thinking.append(text);
        }
        break;
      }
      case 'thought_signature':
        slot.type = 'thought';
        if (delta.signature) slot.signature = delta.signature;
        break;
      case 'arguments_delta':
        slot.type = 'function_call';
        if (delta.arguments) slot.argsBuffer += delta.arguments;
        break;
      default:
        // Media / built-in tool deltas are ignored in v0 (no media-out, no
        // built-in tools). Captured here so the switch stays exhaustive-by-intent.
        break;
    }
  }

  /** Turn the per-index accumulators into a verbatim model-generated Step[]. */
  private finalizeSteps(pending: Map<number, PendingStep>): Step[] {
    const ordered = [...pending.entries()].toSorted((a, b) => a[0] - b[0]);
    const steps: Step[] = [];
    for (const [, slot] of ordered) {
      if (slot.type === 'thought') {
        steps.push({
          type: 'thought',
          ...(slot.signature ? { signature: slot.signature } : {}),
          summary: slot.thought
            ? [{ type: 'text', text: slot.thought }]
            : undefined,
        } satisfies ThoughtStep);
      } else if (slot.type === 'function_call') {
        steps.push({
          type: 'function_call',
          id: slot.callId ?? nanoid(),
          name: slot.callName ?? '',
          arguments: slot.args ?? this.parseArguments(slot.argsBuffer),
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

  private parseArguments(buffer: string): Record<string, unknown> {
    if (!buffer) return {};
    try {
      const parsed = JSON.parse(buffer) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch (error) {
      this.logger.warn(
        `Failed to parse streamed tool arguments: ${getSdkErrorMessage(error)}`,
      );
      return {};
    }
  }

  // ===========================================================================
  // Request building helpers
  // ===========================================================================

  private buildGenerationConfig(
    temperature: number,
    endTag?: string,
  ): GenerationConfig {
    const generationConfig: GenerationConfig = {
      temperature,
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
   * Reuses the wire-agnostic `convertToolSchema` (JSON-Schema flatten +
   * `$schema` strip) and feeds its output into `FunctionT.parameters` — the
   * chat `toGoogleTools` wrapper (`[{ functionDeclarations }]`) is NOT reused.
   */
  private toInteractionsTools(defs: ToolDefinition[]): FunctionT[] {
    return defs.map(
      (d): FunctionT => ({
        type: 'function',
        name: d.name,
        description: d.description,
        parameters: convertToolSchema(d) ?? undefined,
      }),
    );
  }
}
