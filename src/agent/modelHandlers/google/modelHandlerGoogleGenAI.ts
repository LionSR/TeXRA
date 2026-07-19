// Third-party imports
import { nanoid } from 'nanoid';
import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  FinishReason,
  ThinkingLevel,
  PartMediaResolutionLevel,
  createPartFromText,
  createPartFromUri,
  createPartFromFunctionCall,
  createPartFromFunctionResponse,
  createPartFromBase64,
  createFunctionResponsePartFromBase64,
  createUserContent,
  createModelContent,
} from '@google/genai';

// Local imports - agent
import type { StreamHandle } from '@agent/trace';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import { reportMediaAttachmentFailure } from '@agent/modelHandlers/support/mediaAttachmentPolicy';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import { K_SLICE } from '@agent/core/constants';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  GoogleToolCall,
  TokenCountOptions,
} from '@agent/types/ModelHandlerContracts';
import {
  handleStreamingFailure,
  takeTail,
  PARTIAL_TEXT_TAIL_MAX,
} from '@common/errors/sdkErrorUtils';
import replacementEngine from '@replacement/engine';

// Local imports - tools
import type { FileLocation, MediaAttachmentKind } from '@shared/schemas';
import type {
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas/toolResult';
// Local imports - utils
import { getShortDisplayPath } from '@utils/files';
import { joinNonEmpty, pluralize } from '@utils/text/stringUtils';
import {
  isGemini3Model,
  resolveGeminiThinkingLevel,
  resolveGoogleClient,
  supportsGoogleFileUploads,
  uploadGoogleMediaEntries,
} from './googleHandlerShared';
import { computeGooglePrice, normalizeGoogleUsage } from './googleUsage';
import { tagGoogleSdkError } from './googleSdkError';
import {
  extractNonThinkingText,
  isTextPart,
  validateGoogleMessageHistory,
} from './googleMessageHelpers';

// Local file imports
import {
  DEFAULT_ATTACHMENT_MIME_TYPE,
  formatAttachmentSummary,
  formatToolResultAsText,
  loadAttachmentBuffer,
} from '../utils/toolAttachmentUtils';
import { toGoogleTools } from '../toolConversion';
import type {
  Part,
  Content,
  Candidate,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  FunctionResponsePart,
  Tool as GeminiTool,
  GenerateContentConfig,
  CreateChatParameters,
  SendMessageParameters,
} from '@google/genai';

// Type imports

/**
 * Handler for Google models using the native @google/genai SDK and Chat API.
 *
 * Feature-frozen stateless fallback for when `texra.model.useGoogleInteractionsAPI`
 * is off; {@link ModelHandlerGoogleInteractions} is the default, actively
 * developed path (see modelHandlers/README.md). This handler no longer tracks
 * behavioral parity with the Interactions handler — new Google-facing features
 * land there only, not here.
 */
export class ModelHandlerGoogleGenAI extends ModelHandler<
  Content,
  GenerateContentResponseUsageMetadata | null,
  GoogleToolCall,
  GoogleGenAI,
  GenerateContentResponse,
  Part
> {
  private static readonly INLINE_MEDIA_LIMIT_BYTES = 20 * 1024 * 1024;

  private googleClient: GoogleGenAI | null = null;

  private supportsFileUploads(): boolean {
    return supportsGoogleFileUploads(this.capabilities);
  }

  private isGemini3Model(): boolean {
    return isGemini3Model(this.config.fullName);
  }

  /**
   * Get media resolution level for Gemini 3 models.
   * Per Google's recommendations:
   * - Images: MEDIA_RESOLUTION_HIGH (1120 tokens) for maximum quality
   * - PDFs: MEDIA_RESOLUTION_HIGH for better OCR of dense/small text
   * - Video: uses default (low/medium, 70 tokens per frame) for most tasks
   */
  private getMediaResolution(
    mimeType: string,
  ): PartMediaResolutionLevel | undefined {
    if (!this.isGemini3Model()) {
      return undefined;
    }

    if (mimeType.startsWith('image/') || mimeType === 'application/pdf') {
      return PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH;
    }
    // Videos use default which is optimal
    return undefined;
  }

  private getThinkingLevel(): ThinkingLevel | undefined {
    return resolveGeminiThinkingLevel({
      reasoningEffort: this.capabilities.reasoningEffort,
      isGemini3: this.isGemini3Model(),
      isPro: this.config.fullName.includes('-pro'),
      logger: this.logger,
      levels: {
        low: ThinkingLevel.LOW,
        medium: ThinkingLevel.MEDIUM,
        high: ThinkingLevel.HIGH,
      },
      labels: { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' },
    });
  }

  protected getInlineUploadLimitBytes(): number {
    return ModelHandlerGoogleGenAI.INLINE_MEDIA_LIMIT_BYTES;
  }

  protected async uploadMediaEntries(entries: MediaEntry[]): Promise<Part[]> {
    const insertedEntries: MediaEntry[] = [];
    const parts = await uploadGoogleMediaEntries<Part>(entries, {
      getClient: () => this.getClient(),
      inlineLimit: this.getInlineUploadLimitBytes(),
      logger: this.logger,
      buildInline: (data, mimeType) =>
        createPartFromBase64(data, mimeType, this.getMediaResolution(mimeType)),
      buildUploaded: (uri, mimeType) =>
        createPartFromUri(uri, mimeType, this.getMediaResolution(mimeType)),
      onInsertedEntry: (entry) => insertedEntries.push(entry),
    });
    this.setCreatedMediaEntriesForAttachmentLog(insertedEntries);
    return parts;
  }

  async getClient(): Promise<GoogleGenAI> {
    return resolveGoogleClient({
      sdkLabel: 'Native',
      shouldUseServerSideKeys: this.shouldUseServerSideKeys(),
      getApiKey: () => this.getApiKey(),
      getBaseUrl: () => this.getBaseUrl(),
      logger: this.logger,
      cached: this.googleClient,
      setCached: (client) => {
        this.googleClient = client;
      },
    });
  }
  /**
   * Gemini carries thought signatures across parallel function calls, which must
   * be preserved by batching the results into a single follow-up message.
   * Unconditional (not gated on `capabilities.supportsReasoning`) — see the
   * base getter's doc comment (#7101 triage).
   */
  override get requiresBatchedParallelToolResults(): boolean {
    return true;
  }

  /**
   * Google passes the system prompt per-call (as `systemInstruction`) rather
   * than storing it in `messages` (see `initializeMessages` below) — the
   * round flow must resupply it on every invocation.
   */
  override get requiresPerCallSystemPrompt(): boolean {
    return true;
  }

  /**
   * Estimates token count using Google's native countTokens API.
   *
   * @param messages - The Content array representing the conversation history
   * @param options - Token counting options including client, systemPrompt, and lastMessageParts
   * @returns Promise resolving to the total token count
   */
  override async estimateTokenCount(
    messages: Content[],
    options?: TokenCountOptions<GoogleGenAI> & {
      /** Parts for the upcoming user message to include in count */
      lastMessageParts?: Part[];
      /** Google-format tools to include in count (from toGoogleTools) */
      googleTools?: GeminiTool[];
    },
  ): Promise<number> {
    const client = options?.client ?? (await this.getClient());

    // Build countContents: system + history + upcoming message
    const countContents: Content[] = [];
    if (options?.systemPrompt) {
      countContents.push({
        role: 'system',
        parts: [createPartFromText(options.systemPrompt)],
      });
    }
    countContents.push(...messages);

    // Include the upcoming message if provided
    if (options?.lastMessageParts && options.lastMessageParts.length > 0) {
      countContents.push(createUserContent([...options.lastMessageParts]));
    }

    const responseTokenCount = await client.models.countTokens({
      model: this.config.fullName,
      contents: countContents,
      config: {
        abortSignal: options?.signal,
        ...(options?.googleTools?.length && {
          tools: options.googleTools,
        }),
      },
    });

    const totalTokens = responseTokenCount.totalTokens ?? 0;
    this.logger.debug(`Token count of message: ${totalTokens}`);

    return totalTokens;
  }

  protected override get sdkErrorTagger() {
    return tagGoogleSdkError;
  }

  override get supportsForcedToolChoice(): boolean {
    return true;
  }

  /** Creates a Google response after SDK-boundary error tagging is installed. */
  protected override async createResponseImpl(
    options: CreateResponseOptions<Content, GoogleGenAI>,
  ): Promise<CreateResponseResult<GenerateContentResponse, Content>> {
    const {
      client,
      messages,
      temperature,
      systemPrompt,
      endTag,
      signal,
      tools,
      finalTool,
    } = options;
    if (messages.length === 0) {
      this.logger.error('Cannot create response from empty messages array.');
      throw new Error('Messages array cannot be empty.');
    }

    // History excludes the final user message - we send it separately via sendMessage
    const history = messages.slice(0, -1);
    const lastMessage = messages.at(-1);

    // Messages should already be properly formatted with alternating turns
    validateGoogleMessageHistory(history, this.logger);

    const lastMessageParts = Array.isArray(lastMessage?.parts)
      ? lastMessage.parts
      : [];
    if (lastMessageParts.length === 0) {
      this.logger.error('Could not extract valid parts from the last message.');
      throw new Error('Last message conversion resulted in empty parts.');
    }

    // Phase 1: BUILD - Construct provider-specific request parameters
    const generationConfig: GenerateContentConfig = {
      temperature,
      maxOutputTokens: this.getEffectiveMaxOutputTokens(),
      ...(endTag && { stopSequences: [endTag] }),
    };

    // Configure thinking for models that support it (defined in model registry)
    if (this.capabilities.supportsReasoning) {
      const thinkingLevel = this.getThinkingLevel();
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        ...(thinkingLevel && { thinkingLevel }),
      };
    }

    const googleTools = tools?.length ? toGoogleTools(tools) : undefined;
    if (googleTools?.length) {
      generationConfig.tools = googleTools;
      if (finalTool) {
        generationConfig.toolConfig = {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: [finalTool.name],
          },
        };
      }
    }

    const chatParams: CreateChatParameters = {
      model: this.config.fullName,
      history,
      config: generationConfig,
      ...(systemPrompt && { systemInstruction: systemPrompt }),
    };

    // Phase 2: COUNT - Estimate input tokens using built params
    // Phase 3: VALIDATE - Adjust maxOutputTokens if needed
    await this.applyTokenCountLimit({
      // Reuse built params for token counting (build once principle).
      countTokens: () =>
        this.estimateTokenCount(history, {
          client,
          systemPrompt,
          lastMessageParts,
          googleTools,
          signal,
        }),
      currentMaxTokens: generationConfig.maxOutputTokens ?? 8192,
      contextWindow: this.config.contextWindow,
      detailLabel: 'Google: maxOutputTokens reduced to fit context window',
      applyReduced: (adjusted) => {
        generationConfig.maxOutputTokens = adjusted;
      },
    });

    // Phase 4: EXECUTE - Make the API call
    const useStreaming = this.getStreamingConfig();
    // Hoisted so the outer catch can attach any text produced before a
    // mid-stream failure (Google's SDK has no currentMessage accessor, so
    // we accumulate manually as we iterate).
    let aggregatedText = '';
    // Hoisted so the outer catch can finalize the progress streams on a
    // mid-stream failure (otherwise the progress view hangs in a loading
    // state). `StreamHandle.finalize` is idempotent.
    let thinking: StreamHandle | undefined;
    let output: StreamHandle | undefined;

    try {
      this.logger.debug(
        `Creating chat session with history length: ${history.length}`,
      );
      const chat = client.chats.create(chatParams);

      this.logger.debug(
        `Sending message with ${lastMessageParts.length} parts.`,
      );

      const messageParams: SendMessageParameters = {
        message: [...lastMessageParts],
        config: { ...generationConfig, abortSignal: signal },
      };
      if (useStreaming) {
        const stream = await chat.sendMessageStream(messageParams);

        // Opened before the request; the deferred starts fire (if ever) at
        // the first thought/text part — the phase signal for this API.
        thinking = this.createThinkingStream();
        output = this.createOutputStream();
        const thinkingStream = thinking;
        const outputStream = output;

        let baseResponse: GenerateContentResponse | undefined;
        let latestCandidate: Candidate | undefined;
        const aggregatedParts: Part[] = [];
        let usageFromChunks: GenerateContentResponseUsageMetadata | undefined;

        for await (const chunk of stream) {
          baseResponse ??= chunk;
          const candidate = chunk.candidates?.[0];
          if (candidate) {
            latestCandidate = candidate;
            const parts = candidate.content?.parts ?? [];
            aggregatedParts.push(...parts);
            for (const part of parts) {
              if (part.thought && isTextPart(part)) {
                thinkingStream.append(part.text);
              }
            }
          }

          const chunkText = candidate
            ? extractNonThinkingText(candidate.content?.parts ?? [])
            : '';
          if (chunkText) {
            aggregatedText += chunkText;
            outputStream.append(chunkText);
          }

          if (chunk.usageMetadata) {
            usageFromChunks = chunk.usageMetadata;
          }

          if (baseResponse && chunk !== baseResponse) {
            if (chunk.promptFeedback) {
              baseResponse.promptFeedback = chunk.promptFeedback;
            }
            if (chunk.modelVersion) {
              baseResponse.modelVersion = chunk.modelVersion;
            }
            if (chunk.automaticFunctionCallingHistory?.length) {
              baseResponse.automaticFunctionCallingHistory = [
                ...(baseResponse.automaticFunctionCallingHistory ?? []),
                ...chunk.automaticFunctionCallingHistory,
              ];
            }
            if (chunk.responseId) {
              baseResponse.responseId = chunk.responseId;
            }
          }
        }

        if (!baseResponse) {
          throw new Error('Stream produced no response');
        }

        const candidateSource = latestCandidate ?? baseResponse.candidates?.[0];
        if (candidateSource) {
          const candidateParts = aggregatedParts.length
            ? aggregatedParts
            : (candidateSource.content?.parts ?? []);
          baseResponse.candidates = [
            {
              ...candidateSource,
              content: {
                role: candidateSource.content?.role ?? 'model',
                parts: candidateParts,
              },
            },
          ];
        }

        // Always prefer the latest usage metadata from chunks (typically the final
        // chunk has complete data). The first chunk may have partial/empty metadata.
        if (usageFromChunks) {
          baseResponse.usageMetadata = usageFromChunks;
        }

        const finalReasoning = this.processThinkingBlock(baseResponse);
        thinking.finalize(finalReasoning ?? undefined);

        const responseParts =
          baseResponse.candidates?.[0]?.content?.parts ?? [];
        const finalOutputText = extractNonThinkingText(responseParts);
        output.finalize(finalOutputText);

        // Ensure text field excludes thinking content
        // Part.thought is a native property of the Google GenAI SDK Part interface
        const candidateContent = baseResponse.candidates?.[0]?.content;
        if (candidateContent?.parts) {
          // Update the parts array; the SDK will compute the text property from it
          candidateContent.parts = candidateContent.parts.filter(
            (part) => !part.thought,
          );
        }

        return { response: baseResponse };
      }

      const response = await chat.sendMessage(messageParams);
      return { response };
    } catch (error) {
      return handleStreamingFailure(error, {
        // Finalize the progress streams on error so the view does not hang in
        // a loading state. Undefined on the non-streaming path; `finalize` is
        // idempotent so a re-finalize after the success path is a no-op. No
        // explicit final text so any chunks already streamed are preserved
        // (passing `''` would overwrite the visible partial output).
        finalizeOnError: () => {
          thinking?.finalize(undefined);
          output?.finalize();
        },
        // If the stream produced any text before failing, attach a tail to
        // the error so the retry UI can show progress and future
        // continuation logic can reference it. Google's SDK has no
        // currentMessage accessor, so we rely on the manually accumulated
        // buffer above.
        partialTail: () =>
          aggregatedText ? takeTail(aggregatedText, PARTIAL_TEXT_TAIL_MAX) : '',
        // Google's SDK never reaches the SDK-retry boundary here, so this
        // catch does not opt into flow-level auto-retry — always false,
        // unlike every other provider's `connected || tail` formula. It only
        // lifts any accumulated tail onto the error for the retry UI.
        retryEligible: () => false,
        decorateError: (err) => {
          // Error logging follows "log at the boundary" principle - Node's
          // retryPrompt or execFallback will log the error once. We only add
          // debug diagnostics here for specific error types that need
          // additional context.
          if (
            err instanceof Error &&
            err.message?.includes('request.contents[0].parts')
          ) {
            this.logger.debug(
              'Potential issue with sendMessage parameter structure. Check conversion.',
            );
          }
          if (err instanceof Error && err.message?.includes('SAFETY')) {
            // SDK errors may include response metadata at runtime
            const errorWithResponse = err as Error & {
              response?: { promptFeedback?: unknown };
            };
            const promptFeedback = errorWithResponse.response?.promptFeedback;
            const blockReason =
              promptFeedback &&
              typeof promptFeedback === 'object' &&
              'blockReason' in promptFeedback
                ? String(
                    (promptFeedback as { blockReason?: unknown }).blockReason,
                  )
                : undefined;
            const safetyDetail =
              blockReason ??
              (promptFeedback === undefined
                ? undefined
                : JSON.stringify(promptFeedback));
            this.logger.warn(
              `Content blocked by safety filter${safetyDetail ? `: ${safetyDetail}` : ''}.`,
              {
                data: promptFeedback,
              },
            );
          }
          return err;
        },
      });
    }
  }

  /** Initializes the message array for Google GenAI chat models with user prefix, request, and optional media. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: FileLocation[],
    _systemPrompt?: string,
  ): Promise<Content[]> {
    const userContentParts: Part[] = [createPartFromText(userPrefix)];

    if (mediaFiles?.length && this.supportsFileUploads()) {
      const formattedMedia = await this.createMediaForRound(
        mediaFiles,
        'initial',
      );
      if (formattedMedia.length > 0) {
        const attachmentLabel = mediaFiles
          .map((loc) => getShortDisplayPath(loc))
          .join(', ');
        userContentParts.push(
          createPartFromText(
            `\nAttached ${pluralize(mediaFiles.length, 'file')}: ${attachmentLabel}`,
          ),
        );
        userContentParts.push(...formattedMedia);
      }
    }

    userContentParts.push(createPartFromText(`\n${userRequest}`));

    return [createUserContent(userContentParts)];
  }

  /** Creates message array for subsequent rounds, managing image content and message structure. */
  async createRoundMessages(
    messages: Content[],
    userMessage: string,
    mediaFiles?: FileLocation[],
  ): Promise<Content[]> {
    const roundParts: Part[] = [];

    if (mediaFiles?.length && this.supportsFileUploads()) {
      const formattedMedia = await this.createMediaForRound(
        mediaFiles,
        'followUp',
      );
      if (formattedMedia.length > 0) {
        const attachmentLabel = mediaFiles
          .map((loc) => getShortDisplayPath(loc))
          .join(', ');
        roundParts.push(
          createPartFromText(
            `\nProcessing ${pluralize(mediaFiles.length, 'file')}: ${attachmentLabel}`,
          ),
        );
        roundParts.push(...formattedMedia);
      }
    }

    roundParts.push(createPartFromText(userMessage));

    messages.push(createUserContent(roundParts));
    return messages;
  }

  async createUserFollowUpMessages(
    messages: Content[],
    userMessage: string,
  ): Promise<Content[]> {
    const newPart = createPartFromText(userMessage);
    const last = messages.at(-1);

    // Merge with existing user message to maintain alternating user/model turns
    // (Google's Chat API requires strict alternation)
    if (last?.role === 'user') {
      const parts = (last.parts ??= []);
      parts.push(newPart);
    } else {
      messages.push(createUserContent(newPart));
    }

    return messages;
  }

  createAssistantMessage(text: string): Content {
    // Note: Method name retained for interface compatibility, but returns 'model' role per Google SDK
    return createModelContent(createPartFromText(text));
  }

  override extractAssistantText(message: Content): string | undefined {
    if (message.role !== 'model') return undefined;
    if (!Array.isArray(message.parts)) return undefined;
    return joinNonEmpty(message.parts.filter(isTextPart).map((p) => p.text));
  }

  protected override async createMediaMessage(
    mediaFiles: FileLocation[],
  ): Promise<Part[]> {
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

  extractResponse(
    responseObject: GenerateContentResponse,
    endTag: string,
  ): ExtractResponseResult {
    if (!responseObject) {
      this.logger.error(`Invalid (null) response object received.`);
      return {
        text: '',
        usage: undefined,
        stopReason: 'UNKNOWN_EMPTY_RESPONSE',
      };
    }

    if (!responseObject.candidates?.length) {
      if (responseObject?.promptFeedback?.blockReason) {
        const { blockReason, safetyRatings } = responseObject.promptFeedback;
        this.logger.error(`Request blocked: ${blockReason}`, {
          data: { blockReason, safetyRatings },
        });
        return {
          text: '',
          usage: responseObject.usageMetadata ?? undefined,
          stopReason: `Blocked: ${blockReason}`,
        };
      }
      this.logger.error(
        'Invalid or empty response structure from Google GenAI.',
        { data: responseObject },
      );
      return {
        text: '',
        usage: undefined,
        stopReason: 'UNKNOWN_EMPTY_RESPONSE',
      };
    }

    const candidate = responseObject.candidates[0];
    const parts = candidate?.content?.parts ?? [];

    // Compute text directly from parts instead of using SDK's .text getter.
    // The getter may use cached values that don't reflect mutations we made
    // to the candidates array during streaming (lines 536-550, 577-584).
    // Filter out thought parts and concatenate text from remaining parts.
    const rawResponseText = extractNonThinkingText(parts, true);

    // For TOOL CALL ONLY RESPONSE this happens sometimes, we don't want to log it
    let responseText = replacementEngine.applyAll(rawResponseText);

    const usage = responseObject.usageMetadata;
    const stopReason: FinishReason =
      candidate?.finishReason ?? FinishReason.FINISH_REASON_UNSPECIFIED;

    // If the model stopped naturally but didn't include the end tag, append it
    if (
      stopReason === FinishReason.STOP &&
      endTag &&
      !responseText.endsWith(endTag)
    ) {
      this.logger.debug(
        `Model stopped naturally but didn't include end tag. Appending ${endTag}.`,
      );
      responseText += `\n${endTag}`;
    }

    return { text: responseText, usage, stopReason };
  }

  computePrice(
    responseUsage: GenerateContentResponseUsageMetadata | null,
  ): number {
    return computeGooglePrice(responseUsage, this.standardPricingConfig());
  }

  /** Normalizes Google GenAI usage data into a unified format. */
  normalizeUsage(
    rawUsage: GenerateContentResponseUsageMetadata | null,
    responseTimeMs: number,
  ): NormalizedUsage {
    return normalizeGoogleUsage(
      rawUsage,
      responseTimeMs,
      this.standardPricingConfig(),
    );
  }

  protected override get shouldStorePseudoPrefillAsOutput(): boolean {
    return true;
  }

  protected override createPseudoPrefillPrompt(prefill: string): string {
    return `Organize your response with XML tags. Start your response with:\n${prefill}`;
  }

  protected appendUserText(
    messages: Content[],
    text: string,
    placement: 'last-user' | 'continuation',
  ): void {
    const lastMessage = messages.at(-1);
    if (placement === 'last-user' && lastMessage?.role === 'user') {
      (lastMessage.parts ??= []).push(createPartFromText(text));
      return;
    }

    messages.push(createUserContent(createPartFromText(text)));
  }

  protected appendTextToLastAssistantMessage(
    messages: Content[],
    text: string,
    options: { afterContinuationPrompt?: boolean } = {},
  ): boolean {
    const trailingMessage = messages.at(-1);
    if (options.afterContinuationPrompt && trailingMessage?.role === 'user') {
      const trailingText = (trailingMessage.parts ?? [])
        .filter(isTextPart)
        .map((part) => part.text)
        .join('');
      if (this.containCutOffMessage(trailingText)) {
        messages.pop();
        this.logger.debug('Removed user continuation prompt.');
      } else {
        return false;
      }
    }

    const modelMessage = messages.at(-1);
    if (modelMessage?.role !== 'model') return false;

    const parts = (modelMessage.parts ??= []);
    const lastTextPart = parts.findLast(isTextPart);
    if (lastTextPart) {
      lastTextPart.text = (lastTextPart.text ?? '') + text;
    } else {
      parts.push(createPartFromText(text));
      this.logger.warn(
        'Added new text part to last model message as none existed.',
      );
    }
    return true;
  }

  processThinkingBlock(
    responseObject: GenerateContentResponse,
    workspaceState?: AgentWorkspaceState,
  ): string | null {
    const parts = responseObject?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return null;

    const thoughtParts = parts.filter(
      (part): part is Part & { text: string } =>
        Boolean(part.thought) && isTextPart(part),
    );
    if (thoughtParts.length === 0) return null;

    const thoughtContent = thoughtParts
      .map((p) => p.text ?? '')
      .join('')
      .trim();

    if (workspaceState && !workspaceState.reasoning.thinkingAdded) {
      workspaceState.reasoning.thinkingBlocks = thoughtParts.map((p) => ({
        type: 'thinking',
        thinking: p.text,
        thoughtSignature: p.thoughtSignature,
      }));
      workspaceState.reasoning.thinkingAdded = true;
    }

    if (thoughtContent) {
      this.logger.debug('Google GenAI thought summary preview.', {
        data: thoughtContent.slice(0, K_SLICE),
      });
    }

    return thoughtContent || null;
  }

  extractToolUse(responseObject: GenerateContentResponse): GoogleToolCall[] {
    const parts = responseObject?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return [];

    const results: GoogleToolCall[] = [];
    for (const part of parts) {
      const call = part.functionCall;
      if (!call?.name) continue;
      results.push({
        provider: 'google',
        callId: call.id ?? nanoid(),
        name: call.name,
        input: call.args,
        raw: call,
        thoughtSignature:
          typeof part.thoughtSignature === 'string'
            ? part.thoughtSignature
            : undefined,
      });
    }
    return results;
  }

  /**
   * Build a FunctionResponsePart for an attachment using SDK's native type.
   * FunctionResponsePart is the proper way to attach media to function responses
   * per the Google GenAI SDK design.
   */
  private async buildFunctionResponseAttachment(
    attachment: ToolFileAttachment,
  ): Promise<FunctionResponsePart | null> {
    try {
      const buffer = await loadAttachmentBuffer(attachment);
      if (!buffer || buffer.length === 0) {
        this.logger.warn(
          `Skipping empty attachment '${attachment.path}' in Google function response.`,
        );
        return null;
      }

      const mimeType = attachment.mimeType ?? DEFAULT_ATTACHMENT_MIME_TYPE;

      // Use SDK's native FunctionResponsePart for function response attachments
      return createFunctionResponsePartFromBase64(
        buffer.toString('base64'),
        mimeType,
      );
    } catch (attachmentError) {
      reportMediaAttachmentFailure(
        this.logger,
        'toolAttachment',
        attachmentError,
        `failed to encode '${attachment.path}' for Google function response`,
      );
      return null;
    }
  }

  /**
   * Build a single function call part with optional thought signature.
   * Uses SDK's createPartFromFunctionCall and preserves thoughtSignature
   * which is a native property of the Part interface.
   */
  private buildFunctionCallPart(call: GoogleToolCall): Part {
    const args = call.raw.args ?? {};
    const callPart = createPartFromFunctionCall(call.name, args);

    if (callPart.functionCall) {
      callPart.functionCall.id = call.callId;
    }

    // Preserve thought signature if present (required for Gemini 3 models)
    // Note: thoughtSignature is a native property of the Part interface
    if (call.thoughtSignature) {
      callPart.thoughtSignature = call.thoughtSignature;
    }

    return callPart;
  }

  /**
   * Build a function response part with attachments for a single tool call result.
   * Uses SDK's native FunctionResponsePart for attachments, passed to createPartFromFunctionResponse.
   *
   * @param call - The tool call to respond to
   * @param result - Sanitized result (binary data already stripped by source)
   * @param attachments - Pre-extracted file attachments
   */
  private async buildFunctionResponsePart(
    call: GoogleToolCall,
    result: ToolResult,
    attachments: ToolFileAttachment[],
  ): Promise<Part> {
    let attachmentParts: FunctionResponsePart[] = [];
    let attachmentSummary: string | undefined;

    // Only process attachments if the handler supports them
    if (this.canProcessToolResultAttachments && attachments.length > 0) {
      attachmentSummary = formatAttachmentSummary(
        attachments,
        'included-inline',
      );

      const encodedParts = await Promise.all(
        attachments.map((attachment) =>
          this.buildFunctionResponseAttachment(attachment),
        ),
      );

      attachmentParts = encodedParts.filter(
        (part): part is FunctionResponsePart => part !== null,
      );

      if (attachmentParts.length === 0) {
        this.logger.warn(
          `All attachments for Google function response '${call.name}' failed to encode.`,
        );
      }
    }

    // Google SDK requires Record<string, unknown> for response parameter,
    // so we must wrap the text in an object (unlike OpenAI which accepts string)
    const simplifiedResult = {
      result: formatToolResultAsText(result, attachmentSummary),
    };

    // Use SDK's createPartFromFunctionResponse with native attachment support
    // The 4th parameter accepts FunctionResponsePart[] for media attachments
    return createPartFromFunctionResponse(
      call.callId,
      call.name,
      simplifiedResult,
      attachmentParts.length > 0 ? attachmentParts : undefined,
    );
  }

  /**
   * Create follow-up messages for a SINGLE tool call.
   *
   * IMPORTANT: For Gemini 3 models with parallel tool calls, use
   * `createBatchedToolUseFollowUpMessages` instead to properly handle
   * thought signatures. This method creates separate model/user message
   * pairs which can cause validation errors when multiple parallel calls
   * are processed individually.
   */
  async createToolUseFollowUpMessages(
    _client: GoogleGenAI | undefined,
    call: GoogleToolCall,
    result: ToolResult,
    attachments: ToolFileAttachment[],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<Content[]> {
    if (!call.callId) {
      throw new Error('Function call id is required for follow-up messages');
    }

    const callPart = this.buildFunctionCallPart(call);
    const responsePart = await this.buildFunctionResponsePart(
      call,
      result,
      attachments,
    );

    const callParts: Part[] = [];
    if (text) {
      callParts.push(createPartFromText(text));
    }
    callParts.push(callPart);

    // Use SDK helpers for Content creation (single source of truth)
    const callMsg = createModelContent(callParts);
    const resultMsg = createUserContent(responsePart);

    // Reset ephemeral state after consumption (matches Anthropic pattern)
    if (workspaceState) {
      workspaceState.resetServerToolContent();
      workspaceState.resetReasoning();
    }

    return [callMsg, resultMsg];
  }

  /**
   * Create follow-up messages for MULTIPLE parallel tool calls.
   *
   * For Gemini 3 models with thinking enabled, parallel function calls must be
   * structured correctly to preserve thought signatures:
   * - All function calls go in ONE model message (first call has thoughtSignature)
   * - All function responses go in ONE user message
   *
   * This is required because Gemini 3 validates that the first functionCall part
   * in each "step" has a thought_signature. If calls are split into separate
   * model messages, each becomes a new step requiring its own signature.
   *
   * @param entries - One entry per tool call, in original model-response order,
   *   each bundling its own call/result/attachments (structurally aligned).
   * @param workspaceState - Workspace state to reset after consumption
   * @param text - Optional text to include before function calls
   */
  async createBatchedToolUseFollowUpMessages(
    entries: Array<{
      call: GoogleToolCall;
      result: ToolResult;
      attachments: ToolFileAttachment[];
    }>,
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<Content[]> {
    if (entries.length === 0) {
      return [];
    }

    // Validate all calls have IDs
    for (const [index, { call }] of entries.entries()) {
      if (!call.callId) {
        throw new Error(
          `Function call at index ${index} (${call.name ?? 'unknown'}) is missing callId`,
        );
      }
    }

    // Build all function call parts (preserving thought signature on first call)
    const callParts: Part[] = [
      ...(text ? [createPartFromText(text)] : []),
      ...entries.map(({ call }) => this.buildFunctionCallPart(call)),
    ];

    // Build all function response parts in parallel
    const responseParts = await Promise.all(
      entries.map(({ call, result, attachments }) =>
        this.buildFunctionResponsePart(call, result, attachments),
      ),
    );

    // Use SDK helpers for Content creation (single source of truth)
    const callMsg = createModelContent(callParts);
    const resultMsg = createUserContent(responseParts);

    // Reset ephemeral state after consumption (matches Anthropic pattern)
    if (workspaceState) {
      workspaceState.resetServerToolContent();
      workspaceState.resetReasoning();
    }

    return [callMsg, resultMsg];
  }

  // =========================================================================
  // Message modification methods (for post-build enrichment)
  // =========================================================================

  /**
   * Prepend text to the last user message in the conversation.
   */
  prependTextToUserMessage(messages: Content[], text: string): void {
    if (!text.trim()) return;

    const lastUserMsg = messages.findLast((m) => m.role === 'user' && m.parts);
    if (lastUserMsg?.parts) {
      lastUserMsg.parts.unshift(createPartFromText(text));
    }
  }

  /**
   * Add media files to the last user message in the conversation.
   */
  async addMediaToUserMessage(
    messages: Content[],
    mediaFiles: FileLocation[],
  ): Promise<MediaAttachmentKind[]> {
    if (!mediaFiles.length || !this.capabilities.supportsVision) return [];

    const lastUserMsg = messages.findLast((m) => m.role === 'user' && m.parts);
    if (!lastUserMsg?.parts) return [];

    const formattedMedia = await this.createMediaForRound(mediaFiles, 'insert');
    if (formattedMedia.length === 0) return [];
    lastUserMsg.parts.unshift(...formattedMedia);
    return this.consumeInsertedAttachmentKinds('insert');
  }
}
