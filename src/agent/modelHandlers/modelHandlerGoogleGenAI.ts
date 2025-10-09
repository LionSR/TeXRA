// Standard library imports
import * as path from 'path';
import { Buffer } from 'buffer';

// Third-party imports
import {
  GoogleGenAI,
  Part,
  Content,
  GenerateContentResponse,
  FinishReason,
  type Candidate,
  type FunctionCall,
  File,
  createPartFromText,
  createPartFromUri,
  createPartFromFunctionCall,
  createPartFromFunctionResponse,
  GenerateContentConfig,
  type CreateChatParameters,
  type SendMessageParameters,
  type UploadFileParameters,
} from '@google/genai';

// Local imports - agent
import { toGoogleTools } from './toolConversion';
import type { ProviderStopReason } from './types/StopReasonTypes';
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, hasEndTag } from '@agent/core/AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from '@agent/core/AgentState';
import {
  OpenAIAPIResponseUsage,
  ResponseUsageFactory,
  GenerateContentResponseUsageMetadata,
  ExtendedCompletionUsage,
} from '@agent/core/ResponseUsage';
import { ToolState } from '@agent/core/ToolState';

// Local imports - agent components
import {
  ModelHandler,
  type MediaFileResult,
} from '@agent/modelHandlers/ModelHandler';
import { createContinuationMessage } from '@agent/utils/continuationMessage';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { ToolDefinition } from '@model';
import {
  describeAttachments,
  extractToolAttachments,
} from './utils/toolAttachmentUtils';
import { cleanFileContent } from '@replacement/engine';
import replacementEngine from '@replacement/engine';

// Google finish reasons are re-exported from the SDK

// Local constant
import { K_SLICE } from '@utils/config';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import xmlUtils from '@utils/text/xmlUtils';

type GoogleRole = 'user' | 'model';

function ensureParts(message: Content): Part[] {
  if (!Array.isArray(message.parts)) {
    message.parts = []; // Initialize parts array if missing
  }
  return message.parts;
}

function isTextPart(part: Part): part is Part & { text: string } {
  return typeof (part as { text?: unknown }).text === 'string';
}

function getCombinedText(parts: Part[] | undefined): string {
  if (!Array.isArray(parts)) {
    return '';
  }
  return parts
    .filter((part): part is Part & { text: string } => isTextPart(part))
    .map((part) => part.text)
    .join('');
}

function findLastTextPart(
  parts: Part[],
): (Part & { text: string }) | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (isTextPart(part)) {
      return part;
    }
  }
  return undefined;
}

function toGoogleRole(role?: string, logger?: AgentLogger): GoogleRole | null {
  if (role === 'assistant' || role === 'model') {
    return 'model';
  }
  if (role === 'user') {
    return 'user';
  }
  if (role === 'system') {
    logger?.debug(
      `Converting system role to user role for Google API compatibility`,
    );
    return 'user';
  }
  return null;
}

function convertMessagesToGoogleContentHistory(
  messages: Content[],
  logger: AgentLogger,
): Content[] {
  const history: Content[] = [];
  let currentRole: GoogleRole | null = null;
  let currentParts: Part[] = [];

  messages.forEach((message) => {
    const role = toGoogleRole(message.role, logger);
    if (!role) {
      logger.warn(
        `Skipping message with unsupported role during history conversion: ${message.role}`,
      );
      return;
    }

    const parts = Array.isArray(message.parts) ? message.parts : [];
    if (parts.length === 0) {
      return;
    }

    if (role === currentRole) {
      currentParts.push(...parts);
    } else {
      if (currentRole && currentParts.length > 0) {
        history.push({ role: currentRole, parts: [...currentParts] });
      }
      currentRole = role;
      currentParts = [...parts];
    }
  });

  if (currentRole && currentParts.length > 0) {
    history.push({ role: currentRole, parts: [...currentParts] });
  }

  logger.debug(
    `Converted message history length for chat init: ${history.length}`,
  );
  return history;
}

/**
 * Handler for Google models using the native @google/genai SDK and Chat API.
 */
export class ModelHandlerGoogleGenAI extends ModelHandler<
  Content,
  GenerateContentResponseUsageMetadata | null,
  OpenAIAPIResponseUsage,
  FunctionCall,
  GoogleGenAI
> {
  private googleClient: GoogleGenAI | null = null;

  private supportsFileUploads(): boolean {
    return (
      this.config.capabilities.supportsVision ||
      this.config.capabilities.supportsNativeAudio
    );
  }

  protected async uploadMediaEntries(entries: MediaEntry[]): Promise<Part[]> {
    if (entries.length === 0) {
      return [];
    }

    const client = await this.getClient();
    const uploadedParts: Part[] = [];
    const uploadSummaries: MediaFileResult[] = [];

    for (const entry of entries) {
      const fileName = entry.file_name || 'unnamed-file';
      const mimeType = entry.media_type || 'application/octet-stream';
      const uploadSource = this.getUploadSource(entry, mimeType);

      if (!uploadSource) {
        this.logger.error(
          `Skipping media entry ${fileName} due to missing data or mime type`,
        );
        uploadSummaries.push({ path: fileName, ok: false });
        continue;
      }

      try {
        const uploadParams: UploadFileParameters = {
          file: uploadSource,
          config: {
            mimeType,
            displayName: fileName,
          },
        };

        const uploadDescription =
          typeof uploadSource === 'string'
            ? `path ${uploadSource}`
            : `in-memory payload (${mimeType})`;
        this.logger.debug(
          `Uploading media entry ${fileName} via Google GenAI SDK using ${uploadDescription}`,
        );

        const uploadResult: File = await client.files.upload(uploadParams);
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
        uploadedParts.push(createPartFromUri(fileUri, resolvedMimeType));
        uploadSummaries.push({ path: fileName, ok: true });
      } catch (error) {
        this.logger.error(
          `Failed to upload media entry ${fileName}: ${getSdkErrorMessage(error)}`,
          undefined,
          undefined,
          error,
        );
        uploadSummaries.push({ path: fileName, ok: false });
      }
    }

    this.logMediaResults(uploadSummaries);
    return uploadedParts;
  }

  private getUploadSource(
    entry: MediaEntry,
    mimeType: string,
  ): string | globalThis.Blob | null {
    if (
      entry.source_path &&
      entry.source_path.length > 0 &&
      entry.bytes_match_source !== false
    ) {
      return entry.source_path;
    }
    if (entry.data) {
      try {
        const buffer = Buffer.from(entry.data, 'base64');
        return new globalThis.Blob([buffer], { type: mimeType });
      } catch (error) {
        this.logger.error(
          `Failed to decode base64 media for ${entry.file_name}: ${getSdkErrorMessage(error)}`,
          undefined,
          undefined,
          error,
        );
      }
    }
    return null;
  }

  private resolveUploadMimeType(entry: MediaEntry, uploaded: File): string {
    if (uploaded.mimeType && uploaded.mimeType.length > 0) {
      return uploaded.mimeType;
    }
    if (entry.media_type && entry.media_type.length > 0) {
      return entry.media_type;
    }
    return 'application/octet-stream';
  }
  async getClient(): Promise<GoogleGenAI> {
    if (!this.googleClient) {
      const apiKey = await this.getApiKey();
      const baseUrl = this.getBaseUrl();
      // this would get the base url for the google via openai provider
      // const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/';
      // const baseUrl = 'https://generativelanguage.googleapis.com';
      this.logger.debug(`Using Google GenAI Native SDK. Base URL: ${baseUrl}`);
      this.googleClient = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          baseUrl: baseUrl ?? undefined,
        },
      });
    }
    return this.googleClient;
  }

  /** Creates a chat completion response using Google's GenAI API with specified parameters and optional system prompt. */
  async createResponse(
    client: GoogleGenAI,
    messages: Content[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): Promise<GenerateContentResponse> {
    if (messages.length === 0) {
      this.logger.error('Cannot create response from empty messages array.');
      throw new Error('Messages array cannot be empty.');
    }

    const historyMessages = messages.slice(0, -1);
    const lastMessage = messages.at(-1);

    // chatHistory intentionally excludes the final user message because
    // we send it separately with `chat.sendMessage` below

    const chatHistory = convertMessagesToGoogleContentHistory(
      historyMessages,
      this.logger,
    );

    const lastMessageParts = lastMessage?.parts ? [...lastMessage.parts] : [];
    if (lastMessageParts.length === 0) {
      this.logger.error('Could not extract valid parts from the last message.');
      throw new Error('Last message conversion resulted in empty parts.');
    }

    const generationConfig: GenerateContentConfig = {
      temperature: temperature,
      maxOutputTokens: this.config.maxOutputTokens ?? 8192,
      ...(endTag && { stopSequences: [endTag] }),
    };

    if (
      this.config.fullName.includes('2.5-pro') ||
      this.config.fullName.includes('2.5-flash')
    ) {
      generationConfig.thinkingConfig = { includeThoughts: true };
    }

    if (tools && tools.length > 0) {
      generationConfig.tools = toGoogleTools(tools);
    }

    const chatParams: CreateChatParameters = {
      model: this.config.fullName,
      history: chatHistory,
      config: generationConfig,
      ...(systemPrompt && {
        systemInstruction: {
          role: 'system',
          parts: [createPartFromText(systemPrompt)],
        },
      }),
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
        countContents.push(...chatHistory);
        // The token count API expects the upcoming message as part of the
        // history, so append the final user message that will be sent next.
        countContents.push({ role: 'user', parts: [...lastMessageParts] });

        const responseTokenCount = await client.models.countTokens({
          model: this.config.fullName,
          contents: countContents,
          config: { abortSignal: signal },
        });
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
        this.logger.error(
          `Token counting failed, proceeding without token adjustment: ${getSdkErrorMessage(err)}`,
          undefined,
          undefined,
          err,
        );
      }
    }

    const useStreaming = this.getStreamingConfig();

    // this.logger.debug(
    //   `CreateResponse chatParams: ${JSON.stringify(chatParams, null, 2)}`,
    // );

    try {
      this.logger.debug(
        `Creating chat session with history length: ${chatHistory.length}`,
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
        const stream = await chat.sendMessageStream(streamParams);

        const groupId = this.logger.getActiveGroupId();
        const thinking = this.createThinkingStream(groupId);
        const output = this.isOutputStreamingEnabled()
          ? this.createOutputStream(groupId)
          : undefined;
        const fullParts: Part[] = [];
        let lastCandidate: Candidate | undefined;
        let finalUsage: GenerateContentResponseUsageMetadata | undefined;
        const finalResponse = new GenerateContentResponse();
        for await (const chunk of stream) {
          if (chunk.candidates && chunk.candidates.length > 0) {
            lastCandidate = chunk.candidates[0];
            const parts = chunk.candidates[0]?.content?.parts;
            if (Array.isArray(parts)) {
              fullParts.push(...parts);
              for (const part of parts) {
                if (part.thought && isTextPart(part)) {
                  thinking.append(part.text);
                } else if (isTextPart(part)) {
                  output?.append(part.text);
                }
              }
            }
          }
          if (chunk.usageMetadata) {
            finalUsage = chunk.usageMetadata;
          }
          if (chunk.responseId) finalResponse.responseId = chunk.responseId;
          if (chunk.createTime) finalResponse.createTime = chunk.createTime;
          if (chunk.modelVersion)
            finalResponse.modelVersion = chunk.modelVersion;
          if (!finalResponse.promptFeedback && chunk.promptFeedback) {
            finalResponse.promptFeedback = chunk.promptFeedback;
          }
        }

        if (fullParts.length === 0) {
          throw new Error('Stream yielded no chunks');
        }

        finalResponse.usageMetadata = finalUsage;
        finalResponse.candidates = [
          {
            content: { role: 'model', parts: fullParts },
            finishReason:
              lastCandidate?.finishReason ??
              FinishReason.FINISH_REASON_UNSPECIFIED,
            finishMessage: lastCandidate?.finishMessage,
            safetyRatings: lastCandidate?.safetyRatings,
          },
        ];

        const finalReasoning = this.processThinkingBlock(finalResponse);
        thinking.finalize(finalReasoning ?? undefined);
        const finalOutput = fullParts
          .filter(
            (part): part is Part & { text: string } =>
              isTextPart(part) && !part.thought,
          )
          .map((part) => part.text)
          .join('');
        if (output) output.finalize(finalOutput);
        return finalResponse;
      }

      const sendParams: SendMessageParameters = {
        message: [...lastMessageParts],
        config: { ...generationConfig, abortSignal: signal },
      };
      const result = await chat.sendMessage(sendParams);

      return result;
    } catch (error) {
      this.logger.error(
        `Error during Google GenAI Chat API call: ${getSdkErrorMessage(error)}`,
        undefined,
        undefined,
        error,
      );
      if (
        error instanceof Error &&
        error.message?.includes('request.contents[0].parts')
      ) {
        this.logger.error(
          'Potential issue with sendMessage parameter structure. Check conversion.',
        );
      }
      if (error instanceof Error && error.message?.includes('SAFETY')) {
        this.logger.error(
          `Safety block details: ${JSON.stringify((error as any).response?.promptFeedback)}`,
        );
      }
      throw error;
    }
  }

  /** Initializes the message array for Google GenAI chat models with user prefix, request, and optional media. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: string[],
    _systemPrompt?: string,
  ): Promise<Content[]> {
    const userContentParts: Part[] = [createPartFromText(userPrefix)];

    if (mediaFiles && mediaFiles.length > 0 && this.supportsFileUploads()) {
      const formattedMedia = await this.createMediaMessage(mediaFiles);
      if (formattedMedia.length > 0) {
        const pluralSuffix = mediaFiles.length > 1 ? 's' : '';
        const attachmentLabel = mediaFiles
          .map((filePath) => path.basename(filePath))
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

    return [{ role: 'user', parts: userContentParts }];
  }

  /** Creates message array for subsequent rounds, managing image content and message structure. */
  async createRoundMessages(
    messages: Content[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<Content[]> {
    const roundParts: Part[] = [];

    if (mediaFiles && mediaFiles.length > 0 && this.supportsFileUploads()) {
      const formattedMedia = await this.createMediaMessage(mediaFiles);
      if (formattedMedia.length > 0) {
        const pluralSuffix = mediaFiles.length > 1 ? 's' : '';
        const attachmentLabel = mediaFiles
          .map((filePath) => path.basename(filePath))
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

    messages.push({ role: 'user', parts: roundParts });
    return messages;
  }

  async createUserFollowUpMessages(
    messages: Content[],
    userMessage: string,
  ): Promise<Content[]> {
    messages.push({
      role: 'user',
      parts: [createPartFromText(userMessage)],
    });
    return messages;
  }

  createAssistantMessage(text: string): Content {
    // Note: Method name retained for interface compatibility, but returns 'model' role per Google SDK
    return { role: 'model', parts: [createPartFromText(text)] };
  }

  override async createMediaMessage(mediaFiles: string[]): Promise<Part[]> {
    if (!mediaFiles || mediaFiles.length === 0 || !this.supportsFileUploads()) {
      return [];
    }

    const { entries, results } = await this.buildMediaEntries(mediaFiles);
    this.logMediaResults(results);

    if (entries.length === 0) {
      return [];
    }

    return this.uploadMediaEntries(entries);
  }

  createMediaContent(mediaMessage: MediaEntry[]): MediaEntry[] {
    this.logger.warn(
      'createMediaContent called on ModelHandlerGoogleGenAI - should be obsolete.',
    );
    return mediaMessage;
  }

  extractResponse(
    responseObject: GenerateContentResponse,
    endTag: string,
  ): [
    string,
    GenerateContentResponseUsageMetadata | undefined,
    ProviderStopReason,
  ] {
    if (!responseObject) {
      this.logger.error(`Invalid (null) response object received.`);
      return ['', undefined, 'UNKNOWN_EMPTY_RESPONSE'];
    }

    if (!responseObject.candidates || responseObject.candidates.length === 0) {
      if (responseObject?.promptFeedback?.blockReason) {
        const blockReason = responseObject.promptFeedback.blockReason;
        const safetyRatings = JSON.stringify(
          responseObject.promptFeedback.safetyRatings,
        );
        const errorMsg = `Request blocked due to ${blockReason}. Safety ratings: ${safetyRatings}`;
        this.logger.error(errorMsg);
        return [
          '',
          responseObject.usageMetadata || undefined,
          `Blocked: ${blockReason}`,
        ];
      }
      this.logger.error(
        `Invalid or empty response structure from Google GenAI: ${JSON.stringify(responseObject)}`,
      );
      return ['', undefined, 'UNKNOWN_EMPTY_RESPONSE'];
    }

    const candidate = responseObject.candidates[0];

    const rawResponseText = responseObject.text;
    // if (rawResponseText === undefined) {
    //   this.logger.warn(
    //     'Candidate content or parts missing in response object.',
    //   );
    // }
    // For TOOL CALL ONLY RESPONSE this happens sometimes, we don't want to log it
    let responseText = replacementEngine.applyAll(
      (rawResponseText ?? '').trim(),
    );

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

    return [responseText, usage, stopReason];
  }

  computePrice(
    responseUsage: GenerateContentResponseUsageMetadata | null,
  ): number {
    if (!responseUsage) return 0.0;
    const promptTokens = responseUsage.promptTokenCount ?? 0;
    const completionTokens = responseUsage.candidatesTokenCount ?? 0;
    // const completionTokens = responseUsage.responseTokenCount ?? 0;
    // responseTokenCount is not correct, we need to compute the completion tokens from the response, maybe it is response.usageMetadata.candidatesTokenCount
    // completion token computed this way seems to be zero for some reason
    const thoughtTokens = responseUsage.thoughtsTokenCount ?? 0;
    const toolUseTokens = responseUsage.toolUsePromptTokenCount ?? 0;
    return calculateTokenPrice(
      promptTokens + toolUseTokens,
      thoughtTokens + completionTokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );
  }

  computeResponseUsage(
    responseUsage: GenerateContentResponseUsageMetadata | null,
    responseTime: number,
  ): OpenAIAPIResponseUsage {
    // Use the usageMetadata attribute on the response object after calling generate_content. (we did)
    // This returns the total number of tokens in both the input and the output: totalTokenCount.
    // It also returns the token counts of the input and output separately: promptTokenCount (input tokens) and candidatesTokenCount (output tokens).

    const usageObj: ExtendedCompletionUsage = {
      prompt_tokens: responseUsage?.promptTokenCount ?? 0,
      completion_tokens: responseUsage?.candidatesTokenCount ?? 0,
      total_tokens: responseUsage?.totalTokenCount ?? 0,
      prompt_tokens_details: {
        cached_tokens: responseUsage?.cachedContentTokenCount ?? 0,
      },
      completion_tokens_details: {
        reasoning_tokens: responseUsage?.thoughtsTokenCount ?? 0,
        accepted_prediction_tokens: undefined,
        rejected_prediction_tokens: undefined,
      },
    };
    return ResponseUsageFactory.fromOpenAIResponse(
      usageObj,
      this.computePrice(responseUsage),
      responseTime,
    );
  }

  addContinueMessageWithPrefill(/* ... */): void {
    this.logger.debug(
      "Native Google SDK handler does not support assistant prefill continuation. Using 'WithoutPrefill'.",
    );
  }

  addContinueMessageWithoutPrefill(
    messages: Content[],
    _stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    const prefillTokens = toolState.lastResponse.slice(-K_SLICE);
    const userMessageContinuation = createContinuationMessage(
      agentSetting.endTag,
      prefillTokens,
    );
    this.logger.debug(`Adding continuation message.`);
    messages.push({
      role: 'user',
      parts: [createPartFromText(userMessageContinuation)],
    });
  }

  updateMessageContentWithPrefill(/* ... */): void {
    this.logger.debug(
      "Native Google SDK handler does not support assistant prefill update. Using 'WithoutPrefill'.",
    );
  }

  updateMessageContentWithoutPrefill(
    messages: Content[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void {
    this.logger.debug(
      'Updating message history for Google GenAI (no prefill).',
    );
    const lastMessage = messages.at(-1);
    if (
      lastMessage?.role === 'user' &&
      this.containCutOffMessage(getCombinedText(lastMessage.parts))
    ) {
      messages.pop();
      this.logger.debug('Removed user continuation prompt.');
    }

    const modelMessage = messages.at(-1);
    if (modelMessage?.role === 'model') {
      const parts = ensureParts(modelMessage);
      const lastTextPart = findLastTextPart(parts);
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
      messages.push({
        role: 'model',
        parts: [createPartFromText(toolState.accumulatedOutput)],
      });
    }
  }

  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: Content[],
    toolState: ToolState,
    outputFile: string,
    prefill: string,
    groupId?: string,
  ): Promise<[boolean, Content[]]> {
    let endTurn = false;
    this.logger.debug(
      `Initializing output and prefill for ${outputFile}. Prefill content: "${prefill.slice(0, 100)}..."`,
    );

    if (!(await WorkspaceFS.existsAndNonTrivial(outputFile))) {
      this.logger.debug(
        `Output file ${outputFile} does not exist or is empty.`,
      );
      toolState.updateAccumulatedOutput(prefill);

      // Add pseudo-prefill instruction instead of skipping it
      const lastMessage = messages[messages.length - 1];
      const pseudoPrefillMsg = `Organize your response with XML tags. Start your response with:\n${prefill}`;

      if (lastMessage) {
        const parts = ensureParts(lastMessage);
        parts.push(createPartFromText(pseudoPrefillMsg));
      } else {
        messages.push({
          role: 'model',
          parts: [createPartFromText(pseudoPrefillMsg)],
        });
      }

      this.logger.debug(`Added pseudo-prefill message: "${pseudoPrefillMsg}"`);
      return [endTurn, messages];
    }

    this.logger.debug(
      `Output file ${outputFile} exists and is non-trivial. Reading content.`,
    );
    let fileContent = await WorkspaceFS.read(outputFile);
    fileContent = cleanFileContent(fileContent);

    // Extract any existing scratchpad content
    const scratchpad = await xmlUtils.extractScratchpad(
      fileContent,
      'scratchpad',
    );
    if (scratchpad) {
      this.logger.info(scratchpad, groupId, MESSAGE_TYPES.SCRATCHPAD);
    }

    await WorkspaceFS.write(outputFile, fileContent);
    this.logger.debug(`Cleaned and saved existing content to ${outputFile}.`);
    messages.push({
      role: 'model',
      parts: [createPartFromText(fileContent)],
    });
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
    toolState.updateAccumulatedOutput(fileContent);
    toolState.lastResponse = fileContent;
    const state = new AgentStateRound(0);
    this.addContinueMessageWithoutPrefill(
      messages,
      state,
      toolState,
      agentSetting,
      agentConfig,
    );
    endTurn = false;
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
    groupId?: string,
    toolState?: ToolState,
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

    if (toolState && !toolState.thinkingAdded) {
      toolState.thinkingBlocks = thoughtParts.map((p) => ({
        type: 'thinking',
        thinking: p.text,
        thoughtSignature: p.thoughtSignature,
      }));
      toolState.thinkingAdded = true;
    }

    if (thoughtContent) {
      this.logger.debug(
        `Google GenAI thought summary preview: ${thoughtContent.substring(0, K_SLICE)}...`,
        groupId,
      );
    }

    return thoughtContent || null;
  }

  extractToolUse(responseObject: GenerateContentResponse): string | null {
    const candidate = responseObject?.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (Array.isArray(parts)) {
      const funcPart = parts.find((part) => part.functionCall);
      if (funcPart) {
        return JSON.stringify(funcPart.functionCall, null, 2);
      }
    }
    return null;
  }

  async createToolUseFollowUpMessages(
    id: string,
    name: string,
    call: FunctionCall,
    result: Record<string, unknown>,
    _toolState?: ToolState,
    text?: string,
    _client?: GoogleGenAI,
  ): Promise<Content[]> {
    // Handle both args and input fields for backward compatibility
    const args =
      call?.args && typeof call.args === 'object'
        ? (call.args as Record<string, unknown>)
        : ((call as any)?.input ?? {});

    // Use call.name if available, fall back to provided name
    const functionName = call?.name ?? name;

    // Create the call part with the function name and arguments
    const callPart = createPartFromFunctionCall(functionName, args);

    // Use consistent ID for both call and result to ensure proper correlation
    const callId = call?.id ?? id;
    if (callPart.functionCall) {
      callPart.functionCall.id = callId;
    }

    // Use the same ID for the result to maintain correlation
    const { attachments, sanitizedResult } = extractToolAttachments(result);
    if (attachments.length > 0) {
      (sanitizedResult as Record<string, unknown>).attachmentSummary =
        `Attachments available:\n${describeAttachments(attachments).join(
          '\n',
        )}\nUse the read_file tool to download them.`;
    }
    const resultPart = createPartFromFunctionResponse(
      callId,
      functionName,
      sanitizedResult,
    );
    const callParts: Part[] = [];
    if (text) {
      callParts.push(createPartFromText(text));
    }
    callParts.push(callPart);
    const callMsg: Content = { role: 'model', parts: callParts };
    const resultMsg: Content = { role: 'user', parts: [resultPart] };
    return [callMsg, resultMsg];
  }

  // Assuming containCutOffMessage is available from base class ModelHandler
}
