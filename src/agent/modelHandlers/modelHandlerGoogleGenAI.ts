// Standard library imports
import { Buffer } from 'buffer';
import { randomUUID } from 'node:crypto';

// Third-party imports
import {
  GoogleGenAI,
  Part,
  Content,
  GenerateContentResponse,
  FinishReason,
  ThinkingLevel,
  PartMediaResolutionLevel,
  type FunctionCall,
  type FunctionResponsePart,
  File,
  createPartFromText,
  createPartFromUri,
  createPartFromFunctionCall,
  createPartFromFunctionResponse,
  createPartFromBase64,
  createFunctionResponsePartFromBase64,
  createUserContent,
  createModelContent,
  GenerateContentConfig,
  type CreateChatParameters,
  type SendMessageParameters,
} from '@google/genai';

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import { AgentSetting, hasEndTag } from '@agent/core/AgentDataclass';
import { ConversationRoundState } from '@agent/core/AgentState';
import {
  OpenAIAPIResponseUsage,
  GenerateContentResponseUsageMetadata,
} from '@agent/core/ResponseUsage';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import {
  getSdkErrorMessage,
  isContextWindowError,
} from '@common/errors/sdkErrorUtils';
import { AgentLogger } from '@logger/AgentLogger';

import { ReasoningEffort } from '@model/ModelConfig';

// Internal imports
import { cleanFileContent } from '@replacement/engine';
import replacementEngine from '@replacement/engine';

// Local imports - tools
import type { ToolFileAttachment } from '@tools/result';
import type { FileLocation } from '@utils/files';

// Google finish reasons are re-exported from the SDK

// Local constant
import { K_SLICE } from '@utils/config';
import { flexibleFS, getShortDisplayPath } from '@utils/files';
import xmlUtils from '@utils/text/xmlUtils';

// Local file imports
import {
  DEFAULT_ATTACHMENT_MIME_TYPE,
  formatAttachmentSummary,
  loadAttachmentBuffer,
  type ToolResultPayload,
} from './utils/toolAttachmentUtils';
import { executeRequest } from './utils/requestExecutor';
import { toGoogleTools } from './toolConversion';

// Type imports
import type { MediaFileResult } from './support/MediaAttachmentProcessor';
import type { ProviderStopReason } from './types/StopReasonTypes';
import type {
  CreateResponseOptions,
  ExtractResponseResult,
  GoogleToolCall,
} from './types/IModelHandler';

function isTextPart(part: Part): part is Part & { text: string } {
  return typeof (part as { text?: unknown }).text === 'string';
}

/** Extract concatenated text from parts, excluding thought parts */
function extractNonThinkingText(parts: Part[], trim = false): string {
  const text = parts
    .filter((part): part is Part & { text: string } => isTextPart(part))
    .filter((part) => !part.thought)
    .map((part) => part.text)
    .join('');
  return trim ? text.trim() : text;
}

/**
 * Validates that messages have proper alternating user/model turns.
 * All message creation should enforce this natively, so this is a safety check.
 * Logs warnings for any issues found but returns messages unchanged.
 */
export function validateGoogleMessageHistory(
  messages: Content[],
  logger: AgentLogger,
): void {
  let lastRole: string | undefined;

  for (const message of messages) {
    const role = message.role;

    // Check for unsupported roles
    if (role !== 'user' && role !== 'model') {
      logger.warn(
        `Unexpected role in Google message history: ${role}. Expected 'user' or 'model'.`,
      );
    }

    // Check for consecutive same-role messages
    if (lastRole && role === lastRole) {
      logger.warn(
        `Consecutive ${role} messages detected in Google history. This may cause API errors.`,
      );
    }

    // Check for empty parts
    if (!Array.isArray(message.parts) || message.parts.length === 0) {
      logger.warn(`Message with role ${role} has no parts.`);
    }

    lastRole = role;
  }

  logger.debug(`Validated message history length: ${messages.length}`);
}

/**
 * Handler for Google models using the native @google/genai SDK and Chat API.
 */
export class ModelHandlerGoogleGenAI extends ModelHandler<
  Content,
  GenerateContentResponseUsageMetadata | null,
  OpenAIAPIResponseUsage,
  GoogleToolCall,
  GoogleGenAI,
  GenerateContentResponse
> {
  private static readonly INLINE_MEDIA_LIMIT_BYTES = 20 * 1024 * 1024;

  private googleClient: GoogleGenAI | null = null;

  private supportsFileUploads(): boolean {
    return (
      this.config.capabilities.supportsVision ||
      this.config.capabilities.supportsNativeAudio
    );
  }

  private isGemini3Model(): boolean {
    return this.config.fullName.includes('gemini-3-');
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

    const isImage = mimeType.startsWith('image/');
    const isPdf = mimeType === 'application/pdf';

    if (isImage || isPdf) {
      return PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH;
    }
    // Videos use default which is optimal
    return undefined;
  }

  private getThinkingLevel(): ThinkingLevel | undefined {
    const requestedLevel = this.capabilities.reasoningEffort;
    const isGemini3 = this.isGemini3Model();

    if (requestedLevel === ReasoningEffort.NONE) {
      if (isGemini3) {
        // Gemini 3 Pro only supports LOW/HIGH; Flash supports MINIMAL but still requires
        // thought signatures. Use LOW for minimal latency when thinking is "disabled".
        this.logger.warn(
          "Gemini 3 models can't fully disable thinking. Using thinking_level 'LOW'.",
        );
        return ThinkingLevel.LOW;
      }
      return undefined;
    }

    if (requestedLevel === ReasoningEffort.MEDIUM) {
      return ThinkingLevel.MEDIUM;
    }

    if (requestedLevel === ReasoningEffort.LOW) {
      return ThinkingLevel.LOW;
    }

    if (requestedLevel === ReasoningEffort.HIGH) {
      return ThinkingLevel.HIGH;
    }

    return undefined;
  }

  protected getInlineUploadLimitBytes(): number {
    return ModelHandlerGoogleGenAI.INLINE_MEDIA_LIMIT_BYTES;
  }

  protected async uploadMediaEntries(entries: MediaEntry[]): Promise<Part[]> {
    if (entries.length === 0) {
      return [];
    }

    const client = await this.getClient();
    const uploadedParts: Part[] = [];
    const uploadSummaries: MediaFileResult[] = [];
    const inlineLimit = this.getInlineUploadLimitBytes();

    for (const entry of entries) {
      const fileName = entry.file_name ?? 'unnamed-file';
      const mimeType = entry.media_type ?? DEFAULT_ATTACHMENT_MIME_TYPE;
      const inlinePayload =
        typeof entry.data === 'string' && entry.data.length > 0
          ? entry.data
          : null;

      if (inlinePayload) {
        const payloadBytes = Buffer.byteLength(inlinePayload, 'base64');
        if (payloadBytes <= inlineLimit) {
          this.logger.debug(
            `Attaching media entry ${fileName} inline (${payloadBytes} bytes).`,
          );
          const part = createPartFromBase64(
            inlinePayload,
            mimeType,
            this.getMediaResolution(mimeType),
          );
          uploadedParts.push(part);
          uploadSummaries.push({ path: fileName, ok: true });
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
        uploadSummaries.push({ path: fileName, ok: false });
        continue;
      }

      try {
        const uploadPath = entry.source_path as string;
        this.logger.debug(
          `Uploading media entry ${fileName} via Google GenAI SDK from path ${uploadPath}`,
        );
        const uploadResult: File = await executeRequest(
          {
            model: this.config.name,
            operation: `google.files.upload:${fileName}`,
          },
          () =>
            client.files.upload({
              file: uploadPath,
              config: {
                mimeType,
                displayName: fileName,
              },
            }),
        );
        const fileUri = uploadResult.uri;

        if (!fileUri) {
          this.logger.error(
            `Upload result for ${fileName} is missing a URI. Skipping entry.`,
          );
          uploadSummaries.push({ path: fileName, ok: false });
          continue;
        }

        const resolvedMimeType = this.resolveUploadMimeType(
          entry,
          uploadResult,
        );
        const part = createPartFromUri(
          fileUri,
          resolvedMimeType,
          this.getMediaResolution(resolvedMimeType),
        );
        uploadedParts.push(part);
        uploadSummaries.push({ path: fileName, ok: true });
      } catch (error) {
        uploadSummaries.push({ path: fileName, ok: false });
      }
    }

    if (uploadSummaries.some((summary) => !summary.ok)) {
      this.logger.warn(
        'Some media files failed to upload via Google GenAI SDK',
      );
    }
    return uploadedParts;
  }

  private resolveUploadMimeType(entry: MediaEntry, uploaded: File): string {
    if (uploaded.mimeType && uploaded.mimeType.length > 0) {
      return uploaded.mimeType;
    }
    if (entry.media_type && entry.media_type.length > 0) {
      return entry.media_type;
    }
    return DEFAULT_ATTACHMENT_MIME_TYPE;
  }

  async getClient(): Promise<GoogleGenAI> {
    if (!this.googleClient) {
      const credential = await this.getApiKey();
      const baseUrl = this.getBaseUrl();
      this.logger.debug(`Using Google GenAI Native SDK. Base URL: ${baseUrl}`);

      // For relay auth: credential is the user's JWT, SDK sends it via x-goog-api-key header
      this.googleClient = new GoogleGenAI({
        apiKey: credential,
        httpOptions: {
          baseUrl: baseUrl ?? undefined,
        },
      });
    }
    return this.googleClient;
  }

  /** Creates a chat completion response using Google's GenAI API with specified parameters and optional system prompt. */
  async createResponse(
    options: CreateResponseOptions<Content, GoogleGenAI>,
  ): Promise<GenerateContentResponse> {
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

    const generationConfig: GenerateContentConfig = {
      temperature: temperature,
      maxOutputTokens: this.config.maxOutputTokens ?? 8192,
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

    if (tools && tools.length > 0) {
      generationConfig.tools = toGoogleTools(tools);
    }

    const chatParams: CreateChatParameters = {
      model: this.config.fullName,
      history,
      config: generationConfig,
      ...(systemPrompt && { systemInstruction: systemPrompt }),
    };

    if (this.capabilities.supportsTokenCounting) {
      try {
        const countContents: Content[] = [];
        if (systemPrompt) {
          countContents.push({
            role: 'system',
            parts: [createPartFromText(systemPrompt)],
          });
        }
        countContents.push(...history);
        // The token count API expects the upcoming message as part of the
        // history, so append the final user message that will be sent next.
        countContents.push(createUserContent([...lastMessageParts]));

        const responseTokenCount = await executeRequest(
          {
            model: this.config.name,
            operation: 'google.models.countTokens',
            signal,
          },
          () =>
            client.models.countTokens({
              model: this.config.fullName,
              contents: countContents,
              config: { abortSignal: signal },
            }),
        );
        const totalTokens = responseTokenCount.totalTokens ?? 0;
        this.logger.debug(`Token count of message: ${totalTokens}`);
        if (totalTokens > this.config.contextWindow) {
          this.logger.error(
            `Token count of message exceeds context window: ${totalTokens} > ${this.config.contextWindow}`,
          );
          throw new Error(
            `Token count of message exceeds context window: ${totalTokens} > ${this.config.contextWindow}`,
          );
        }
        if (
          this.config.contextWindow - totalTokens <
          (generationConfig.maxOutputTokens ?? 8192)
        ) {
          this.logger.warn(
            `Token count of message plus max tokens exceeds context window: ${totalTokens} + ${generationConfig.maxOutputTokens} > ${this.config.contextWindow}. Reducing max tokens to ${this.config.contextWindow - totalTokens}.`,
          );
          generationConfig.maxOutputTokens =
            this.config.contextWindow - totalTokens - 10;
        }
      } catch (err) {
        // Re-throw context window violations - these are intentional validation errors
        // that should fail fast, not be swallowed by soft failure
        if (isContextWindowError(err)) {
          throw err;
        }
        // Soft failure for token counting API errors - proceed without adjustment
        this.logger.warn(
          `Token counting failed: ${getSdkErrorMessage(err)}. Proceeding without token adjustment.`,
        );
      }
    }

    const useStreaming = this.getStreamingConfig();

    try {
      this.logger.debug(
        `Creating chat session with history length: ${history.length}`,
      );
      const chat = client.chats.create(chatParams);

      this.logger.debug(
        `Sending message with ${lastMessageParts.length} parts.`,
      );

      if (useStreaming) {
        const streamParams: SendMessageParameters = {
          message: [...lastMessageParts],
          config: { ...generationConfig, abortSignal: signal },
        };
        const stream = await executeRequest(
          {
            model: this.config.name,
            operation: 'google.chat.sendMessageStream',
            signal,
          },
          () => chat.sendMessageStream(streamParams),
        );

        const thinking = this.createThinkingStream();
        const output = this.isOutputStreamingEnabled()
          ? this.createOutputStream()
          : undefined;

        let baseResponse: GenerateContentResponse | undefined;
        let latestCandidate:
          | NonNullable<GenerateContentResponse['candidates']>[number]
          | undefined;
        const aggregatedParts: Part[] = [];
        let aggregatedText = '';
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
                thinking.append(part.text);
              }
            }
          }

          const chunkText = chunk.text ?? '';
          if (chunkText) {
            aggregatedText += chunkText;
            output?.append(chunkText);
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
              const existingHistory =
                baseResponse.automaticFunctionCallingHistory ?? [];
              baseResponse.automaticFunctionCallingHistory =
                existingHistory.length === 0
                  ? [...chunk.automaticFunctionCallingHistory]
                  : [
                      ...existingHistory,
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

        const nonThinkingText = extractNonThinkingText(aggregatedParts);

        let finalOutputText = aggregatedText || nonThinkingText;
        if (!finalOutputText && baseResponse.text) {
          finalOutputText = baseResponse.text;
          this.logger.warn(
            'Finalizing Google stream with base response text fallback; no chunk text aggregated.',
          );
        }
        output?.finalize(finalOutputText);

        // Ensure text field excludes thinking content
        // Part.thought is a native property of the Google GenAI SDK Part interface
        const candidateContent = baseResponse.candidates?.[0]?.content;
        if (candidateContent?.parts) {
          const filteredParts = candidateContent.parts.filter(
            (part) => !part.thought,
          );
          // Update the parts array; the SDK will compute the text property from it
          candidateContent.parts = filteredParts;
        }

        return baseResponse;
      }

      const sendParams: SendMessageParameters = {
        message: [...lastMessageParts],
        config: { ...generationConfig, abortSignal: signal },
      };
      const result = await executeRequest(
        {
          model: this.config.name,
          operation: 'google.chat.sendMessage',
          signal,
        },
        () => chat.sendMessage(sendParams),
      );

      return result;
    } catch (error) {
      // Error logging follows "log at the boundary" principle - Node's retryPrompt
      // or execFallback will log the error once. We only add debug diagnostics here
      // for specific error types that need additional context.
      if (
        error instanceof Error &&
        error.message?.includes('request.contents[0].parts')
      ) {
        this.logger.debug(
          'Potential issue with sendMessage parameter structure. Check conversion.',
        );
      }
      if (error instanceof Error && error.message?.includes('SAFETY')) {
        // SDK errors may include response metadata at runtime
        const errorWithResponse = error as Error & {
          response?: { promptFeedback?: unknown };
        };
        this.logger.warn(
          `Content blocked by safety filter: ${JSON.stringify(errorWithResponse.response?.promptFeedback)}`,
        );
      }
      throw error;
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

    if (mediaFiles && mediaFiles.length > 0 && this.supportsFileUploads()) {
      const formattedMedia = await this.createMediaMessage(mediaFiles);
      if (formattedMedia.length > 0) {
        const pluralSuffix = mediaFiles.length > 1 ? 's' : '';
        const attachmentLabel = mediaFiles
          .map((loc) => getShortDisplayPath(loc))
          .join(', ');
        userContentParts.push(
          createPartFromText(
            `\nAttached file${pluralSuffix}: ${attachmentLabel}`,
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

    if (mediaFiles && mediaFiles.length > 0 && this.supportsFileUploads()) {
      const formattedMedia = await this.createMediaMessage(mediaFiles);
      if (formattedMedia.length > 0) {
        const pluralSuffix = mediaFiles.length > 1 ? 's' : '';
        const attachmentLabel = mediaFiles
          .map((loc) => getShortDisplayPath(loc))
          .join(', ');
        roundParts.push(
          createPartFromText(
            `\nProcessing file${pluralSuffix}: ${attachmentLabel}`,
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

  override async createMediaMessage(
    mediaFiles: FileLocation[],
  ): Promise<Part[]> {
    if (!mediaFiles || mediaFiles.length === 0 || !this.supportsFileUploads()) {
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

  createMediaContent(mediaMessage: MediaEntry[]): MediaEntry[] {
    // Google GenAI handles media content directly without transformation
    return mediaMessage;
  }

  extractResponse(
    responseObject: GenerateContentResponse,
    endTag: string,
  ): ExtractResponseResult {
    if (!responseObject) {
      this.logger.error(`Invalid (null) response object received.`);
      return {
        response: '',
        usage: undefined,
        stopReason: 'UNKNOWN_EMPTY_RESPONSE',
      };
    }

    if (!responseObject.candidates || responseObject.candidates.length === 0) {
      if (responseObject?.promptFeedback?.blockReason) {
        const blockReason = responseObject.promptFeedback.blockReason;
        const safetyRatings = JSON.stringify(
          responseObject.promptFeedback.safetyRatings,
        );
        const errorMsg = `Request blocked due to ${blockReason}. Safety ratings: ${safetyRatings}`;
        this.logger.error(errorMsg);
        return {
          response: '',
          usage: responseObject.usageMetadata || undefined,
          stopReason: `Blocked: ${blockReason}`,
        };
      }
      this.logger.error(
        `Invalid or empty response structure from Google GenAI: ${JSON.stringify(responseObject)}`,
      );
      return {
        response: '',
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

    return { response: responseText, usage, stopReason };
  }

  /**
   * Computes input and output token counts from Gemini usageMetadata.
   *
   * Google's formula: totalTokenCount = promptTokenCount + candidatesTokenCount
   *                                   + toolUsePromptTokenCount + thoughtsTokenCount
   *
   * For output tokens, we prefer the sum of candidatesTokenCount + thoughtsTokenCount
   * when available. When individual fields are unpopulated (which can happen in
   * streaming mode for some models), we derive output from totalTokenCount using
   * the documented formula.
   *
   * Note: candidatesTokenCount does NOT include thinking tokens per llm-gemini#75.
   *
   * TODO: Future work - extract per-modality token breakdown from promptTokensDetails[],
   * candidatesTokensDetails[], cacheTokensDetails[], and toolUsePromptTokensDetails[].
   * Each array contains ModalityTokenCount objects with modality (TEXT, IMAGE, VIDEO,
   * AUDIO, DOCUMENT) and tokenCount. Note that PDF pages are currently reported under
   * IMAGE modality, not DOCUMENT. This would enable modality-specific cost tracking
   * and better insights into multimodal token consumption.
   */
  private computeTokenCounts(
    usage: GenerateContentResponseUsageMetadata | null,
  ): { inputTokens: number; outputTokens: number; reasoningTokens: number } {
    if (!usage) {
      return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    }

    const promptTokens = usage.promptTokenCount ?? 0;
    const toolUseTokens = usage.toolUsePromptTokenCount ?? 0;
    const candidatesTokens = usage.candidatesTokenCount ?? 0;
    const reasoningTokens = usage.thoughtsTokenCount ?? 0;

    const inputTokens = promptTokens + toolUseTokens;

    // Per Google's formula: outputTokens = candidatesTokenCount + thoughtsTokenCount
    // When these fields are populated, use them directly.
    // When unpopulated (some models in streaming), derive from totalTokenCount.
    const directOutput = candidatesTokens + reasoningTokens;
    const derivedOutput =
      usage.totalTokenCount !== undefined
        ? Math.max(0, usage.totalTokenCount - inputTokens)
        : 0;

    // Use direct values when available; otherwise use derived calculation
    const outputTokens = directOutput > 0 ? directOutput : derivedOutput;

    return { inputTokens, outputTokens, reasoningTokens };
  }

  computePrice(
    responseUsage: GenerateContentResponseUsageMetadata | null,
  ): number {
    if (!responseUsage) return 0.0;
    const { inputTokens, outputTokens } =
      this.computeTokenCounts(responseUsage);

    return calculateTokenPrice(
      inputTokens,
      outputTokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );
  }

  /** Normalizes Google GenAI usage data into a unified format. */
  normalizeUsage(
    rawUsage: GenerateContentResponseUsageMetadata | null,
    responseTimeMs: number,
  ): NormalizedUsage {
    if (!rawUsage) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        responseTimeMs,
        provider: 'google',
      };
    }

    const { inputTokens, outputTokens, reasoningTokens } =
      this.computeTokenCounts(rawUsage);

    const cachedTokens = rawUsage.cachedContentTokenCount ?? 0;
    const percentageCached =
      inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;

    return {
      inputTokens,
      outputTokens,
      cost: this.computePrice(rawUsage),
      responseTimeMs,
      provider: 'google',
      cachedInputTokens: cachedTokens || undefined,
      percentageCached: percentageCached > 0 ? percentageCached : undefined,
      reasoningTokens: reasoningTokens || undefined,
      toolUsePromptTokens: rawUsage.toolUsePromptTokenCount || undefined,
      _native: rawUsage,
    };
  }

  addContinueMessageWithPrefill(
    _messages: Content[],
    _stateRound: ConversationRoundState,
    _workspaceState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    this.logger.debug(
      "Native Google SDK handler does not support assistant prefill continuation. Using 'WithoutPrefill'.",
    );
  }

  addContinueMessageWithoutPrefill(
    messages: Content[],
    _stateRound: ConversationRoundState,
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    const userMessageContinuation = this.createContinuationPrompt(
      workspaceState,
      agentSetting,
    );
    this.logger.debug(`Adding continuation message.`);
    messages.push(
      createUserContent(createPartFromText(userMessageContinuation)),
    );
  }

  updateMessageContentWithPrefill(
    _messages: Content[],
    _bestConnector: string,
    _newResponse: string,
    _workspaceState: AgentWorkspaceState,
  ): void {
    this.logger.debug(
      "Native Google SDK handler does not support assistant prefill update. Using 'WithoutPrefill'.",
    );
  }

  updateMessageContentWithoutPrefill(
    messages: Content[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    this.logger.debug(
      'Updating message history for Google GenAI (no prefill).',
    );
    const lastMessage = messages.at(-1);
    if (
      lastMessage?.role === 'user' &&
      this.containCutOffMessage(
        (lastMessage.parts ?? [])
          .filter((part): part is Part & { text: string } => isTextPart(part))
          .map((part) => part.text)
          .join(''),
      )
    ) {
      messages.pop();
      this.logger.debug('Removed user continuation prompt.');
    }

    const modelMessage = messages.at(-1);
    if (modelMessage?.role === 'model') {
      const parts = (modelMessage.parts ??= []);
      const lastTextPart = parts.findLast(isTextPart);
      if (lastTextPart) {
        lastTextPart.text =
          (lastTextPart.text ?? '') + bestConnector + newResponse;
      } else {
        parts.push(createPartFromText(bestConnector + newResponse));
        this.logger.warn(
          'Added new text part to last model message as none existed.',
        );
      }
    } else {
      this.logger.debug('Adding new model message for the response.');
      messages.push(
        createModelContent(
          createPartFromText(workspaceState.assembly.accumulatedOutput),
        ),
      );
    }
  }

  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: Content[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
    prefill: string,
  ): Promise<[boolean, Content[]]> {
    let endTurn = false;
    this.logger.debug(
      `Initializing output and prefill for ${outputLocation.absolutePath}. Prefill content: "${prefill.slice(0, 100)}..."`,
    );

    if (!(await flexibleFS.existsAndNonTrivial(outputLocation))) {
      this.logger.debug(
        `Output file ${outputLocation.absolutePath} does not exist or is empty.`,
      );
      workspaceState.assembly.accumulatedOutput = prefill;

      // Add pseudo-prefill instruction to user message
      // (Google's Chat API requires alternating user/model turns)
      const lastMessage = messages.at(-1);
      const pseudoPrefillMsg = `Organize your response with XML tags. Start your response with:\n${prefill}`;

      if (lastMessage?.role === 'user') {
        const parts = (lastMessage.parts ??= []);
        parts.push(createPartFromText(pseudoPrefillMsg));
      } else {
        // Either no message or last is model - add new user message
        messages.push(createUserContent(createPartFromText(pseudoPrefillMsg)));
      }

      this.logger.debug(`Added pseudo-prefill message: "${pseudoPrefillMsg}"`);
      return [endTurn, messages];
    }

    this.logger.debug(
      `Output file ${outputLocation.absolutePath} exists and is non-trivial. Reading content.`,
    );
    let fileContent = await flexibleFS.read(outputLocation);
    fileContent = cleanFileContent(fileContent);

    // Extract any existing scratchpad content
    const scratchpad = await xmlUtils.extractScratchpad(
      fileContent,
      'scratchpad',
    );
    if (scratchpad) {
      this.logger.logScratchpad(scratchpad);
    }

    await flexibleFS.write(outputLocation, fileContent);
    this.logger.debug(
      `Cleaned and saved existing content to ${outputLocation.absolutePath}.`,
    );

    // Update workspace state - critical for multi-round agents on resume
    // so that subsequent rounds have correct context
    workspaceState.assembly.accumulatedOutput = fileContent;
    workspaceState.assembly.lastResponse = fileContent;

    messages.push(createModelContent(createPartFromText(fileContent)));
    this.logger.debug(
      `Added existing file content to messages as 'model' role.`,
    );

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug(
        'End tag detected in existing file content - skipping generation.',
      );
      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.debug(
      'Existing file content found without end tag - continuing generation.',
    );
    // Note: workspace state already updated above (lines 1062-1063)
    const state = new ConversationRoundState(0);
    this.addContinueMessageWithoutPrefill(
      messages,
      state,
      workspaceState,
      agentSetting,
      agentConfig,
    );
    return [endTurn, messages];
  }

  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    // Google SDK uses the FinishReason enum for stop reasons
    const hitTokenLimit = stopReason === FinishReason.MAX_TOKENS;
    const containsEndTag = hasEndTag(agentSetting, newResponse);

    if (hitTokenLimit && !containsEndTag) {
      this.logger.debug(
        `Should continue: MAX_TOKENS reached and end tag '${agentSetting.endTag}' is missing.`,
      );
      return true;
    }
    this.logger.debug(
      `Should not continue: StopReason='${stopReason}', HasEndTag='${containsEndTag}'.`,
    );
    return false;
  }

  processThinkingBlock(
    responseObject: GenerateContentResponse,
    workspaceState?: AgentWorkspaceState,
  ): string | null {
    if (
      !responseObject ||
      !responseObject.candidates ||
      responseObject.candidates.length === 0
    ) {
      return null;
    }

    const candidate = responseObject.candidates[0];
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) {
      return null;
    }

    const thoughtParts = parts.filter(
      (part): part is Part & { text: string } =>
        Boolean(part.thought) && isTextPart(part),
    );

    if (thoughtParts.length === 0) {
      return null;
    }

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
      this.logger.debug(
        `Google GenAI thought summary preview: ${thoughtContent.substring(0, K_SLICE)}...`,
      );
    }

    return thoughtContent || null;
  }

  extractToolUse(responseObject: GenerateContentResponse): GoogleToolCall[] {
    const candidate = responseObject?.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) {
      return [];
    }

    type FunctionCallWithSignature = {
      call: FunctionCall;
      thoughtSignature: string | undefined;
    };

    const functionCalls = parts
      .map<FunctionCallWithSignature | null>((part) => {
        const call = part.functionCall;
        if (!call?.name) {
          return null;
        }
        return {
          call,
          thoughtSignature:
            typeof part.thoughtSignature === 'string'
              ? part.thoughtSignature
              : undefined,
        };
      })
      .filter((part): part is FunctionCallWithSignature => part !== null);

    if (functionCalls.length === 0) {
      return [];
    }

    return functionCalls.map(({ call, thoughtSignature }) => ({
      provider: 'google',
      callId: call.id ?? randomUUID(),
      name: call.name!,
      input: call.args,
      raw: call,
      thoughtSignature,
    }));
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

      const mimeType =
        typeof attachment.mimeType === 'string' &&
        attachment.mimeType.length > 0
          ? attachment.mimeType
          : DEFAULT_ATTACHMENT_MIME_TYPE;

      // Use SDK's native FunctionResponsePart for function response attachments
      return createFunctionResponsePartFromBase64(
        buffer.toString('base64'),
        mimeType,
      );
    } catch (attachmentError) {
      const message =
        attachmentError instanceof Error
          ? attachmentError.message
          : String(attachmentError);
      this.logger.warn(
        `Failed to encode attachment '${attachment.path}' for Google function response: ${message}`,
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
    result: ToolResultPayload,
    attachments: ToolFileAttachment[],
  ): Promise<Part> {
    // Result is already sanitized by source - create mutable copy for adding attachmentSummary
    const finalResult: ToolResultPayload = { ...result };
    let attachmentParts: FunctionResponsePart[] = [];

    // Only process attachments if the handler supports them
    if (this.canProcessToolResultAttachments && attachments.length > 0) {
      finalResult.attachmentSummary = formatAttachmentSummary(
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

      if (attachmentParts.length === 0 && attachments.length > 0) {
        this.logger.warn(
          `All attachments for Google function response '${call.name}' failed to encode.`,
        );
      }
    }

    // Use SDK's createPartFromFunctionResponse with native attachment support
    // The 4th parameter accepts FunctionResponsePart[] for media attachments
    return createPartFromFunctionResponse(
      call.callId,
      call.name,
      finalResult,
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
    result: ToolResultPayload,
    attachments: ToolFileAttachment[],
    _workspaceState?: AgentWorkspaceState,
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
   * @param calls - Array of tool calls (should preserve original order from model response)
   * @param results - Array of sanitized results (same order as calls)
   * @param attachmentsPerCall - Array of attachment arrays (same order as calls)
   * @param _workspaceState - Unused, for interface compatibility
   * @param text - Optional text to include before function calls
   */
  async createBatchedToolUseFollowUpMessages(
    calls: GoogleToolCall[],
    results: ToolResultPayload[],
    attachmentsPerCall: ToolFileAttachment[][],
    _workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<Content[]> {
    if (calls.length === 0) {
      return [];
    }

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

    // Validate all calls have IDs
    for (const [index, call] of calls.entries()) {
      if (!call.callId) {
        throw new Error(
          `Function call at index ${index} (${call.name ?? 'unknown'}) is missing callId`,
        );
      }
    }

    // Build all function call parts (preserving thought signature on first call)
    const callParts: Part[] = [
      ...(text ? [createPartFromText(text)] : []),
      ...calls.map((call) => this.buildFunctionCallPart(call)),
    ];

    // Build all function response parts in parallel
    const responseParts = await Promise.all(
      calls.map((call, i) =>
        this.buildFunctionResponsePart(call, results[i], attachmentsPerCall[i]),
      ),
    );

    // Use SDK helpers for Content creation (single source of truth)
    const callMsg = createModelContent(callParts);
    const resultMsg = createUserContent(responseParts);

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
  ): Promise<void> {
    if (!mediaFiles.length || !this.config.capabilities.supportsVision) return;

    const lastUserMsg = messages.findLast((m) => m.role === 'user' && m.parts);
    if (!lastUserMsg?.parts) return;

    try {
      const formattedMedia = await this.createMediaMessage(mediaFiles);
      lastUserMsg.parts.unshift(...formattedMedia);
    } catch (err) {
      this.logger.logError(
        `Error adding media to user message: ${getSdkErrorMessage(err)}`,
        err,
        { operation: 'add media to user message' },
      );
    }
  }
}
