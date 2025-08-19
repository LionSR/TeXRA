// Standard library imports
import * as path from 'path';

// Third-party imports
import {
  GoogleGenAI,
  Part,
  Content,
  GenerateContentResponse,
  FinishReason,
  File,
  createPartFromUri,
  createPartFromFunctionCall,
  createPartFromFunctionResponse,
  GenerateContentConfig,
  type CreateChatParameters,
  type SendMessageParameters,
  type UploadFileParameters,
} from '@google/genai';

// Local imports - agent components
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, hasEndTag } from '@agent/core/AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from '@agent/core/AgentState';
import { ToolState } from '@agent/core/ToolState';
import {
  OpenAIAPIResponseUsage,
  ResponseUsageFactory,
  GenerateContentResponseUsageMetadata,
  ExtendedCompletionUsage,
} from '@agent/core/ResponseUsage';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { AgentLogger } from '@logger/AgentLogger';
import type { ToolDefinition } from '@model';
import { toGoogleTools } from './toolConversion';

// Local imports - utilities
import { WorkspaceFS, AbsoluteFS, getMimeType } from '@utils/files';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import xmlUtils from '@utils/text/xmlUtils';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import { MESSAGE_TYPES } from '@logger/messageTypes';

import { cleanFileContent } from '@replacement/engine';
import replacementEngine from '@replacement/engine';

import type { ProviderStopReason } from './types/StopReasonTypes';
// Google finish reasons are re-exported from the SDK

// Local constant
import { K_SLICE } from '@utils/config';

// Internal type definition
type InternalMessagePart = {
  type: 'text' | 'file_uri' | string;
  text?: string;
  uri?: string;
  mimeType?: string;
};

// For the Message interface, I kept a simple version because:
// 1. Google's Content type has role?: string (optional), while our internal messages always have a role
// 2. Google's Content uses parts?: Part[] while our internal structure uses content: string | InternalMessagePart[]

// Define a message interface that matches our internal structure
// but is compatible with Google's Content type
interface Message {
  role: string;
  content?: string | InternalMessagePart[]; // Used for internal message representation
  parts?: Part[]; // Used for Google-specific message format when sending to API
}

// Helper function
function convertInternalPartsToGoogleParts(
  internalParts: InternalMessagePart[],
  logger: AgentLogger,
): Part[] {
  return internalParts
    .map((part: InternalMessagePart): Part | null => {
      if (part.type === 'text' && typeof part.text === 'string') {
        return { text: part.text };
      } else if (part.type === 'file_uri' && part.uri && part.mimeType) {
        return createPartFromUri(part.uri, part.mimeType);
      } else {
        logger.warn(
          `Skipping unsupported internal part type for sendMessage: ${JSON.stringify(part)}`,
        );
        return null;
      }
    })
    .filter((part: Part | null): part is Part => part !== null);
}

// Helper function
function convertMessagesToGoogleContentHistory(
  messages: Message[],
  logger: AgentLogger,
): Content[] {
  const history: Content[] = [];
  let currentRole: 'user' | 'model' | null = null;
  let currentParts: Part[] = [];

  messages.forEach((msg) => {
    const role =
      msg.role === 'assistant' ? 'model' : msg.role === 'user' ? 'user' : null;
    if (!role) return;

    let parts: Part[] = [];
    if (Array.isArray(msg.parts)) {
      parts = msg.parts;
    } else if (Array.isArray(msg.content)) {
      parts = msg.content
        .map((part: InternalMessagePart): Part | null => {
          if (part.type === 'text' && typeof part.text === 'string') {
            return { text: part.text };
          } else if (part.type === 'file_uri' && part.uri && part.mimeType) {
            return { fileData: { fileUri: part.uri, mimeType: part.mimeType } };
          } else {
            logger.warn(
              `Skipping unsupported internal part type for history conversion: ${JSON.stringify(part)}`,
            );
            return null;
          }
        })
        .filter((part: Part | null): part is Part => part !== null);
    } else if (typeof msg.content === 'string') {
      parts = [{ text: msg.content }];
    }

    if (parts.length === 0) return;

    if (role === currentRole) {
      currentParts.push(...parts);
    } else {
      if (currentRole && currentParts.length > 0) {
        history.push({ role: currentRole, parts: currentParts });
      }
      currentRole = role;
      currentParts = parts;
    }
  });

  if (currentRole && currentParts.length > 0) {
    history.push({ role: currentRole, parts: currentParts });
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
  OpenAIAPIResponseUsage
> {
  private googleClient: GoogleGenAI | null = null;
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
    messages: Message[],
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

    let lastMessageParts: Part[] = [];
    if (lastMessage) {
      if (Array.isArray(lastMessage.parts)) {
        lastMessageParts = lastMessage.parts;
      } else if (Array.isArray(lastMessage.content)) {
        lastMessageParts = convertInternalPartsToGoogleParts(
          lastMessage.content,
          this.logger,
        );
      } else if (typeof lastMessage.content === 'string') {
        lastMessageParts = [{ text: lastMessage.content }];
      }
    }
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
        systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
      }),
    };

    if (this.capabilities.supportsTokenCounting) {
      try {
        const countContents: Content[] = [];
        if (systemPrompt) {
          countContents.push({
            role: 'system',
            parts: [{ text: systemPrompt }],
          });
        }
        countContents.push(...chatHistory);
        // The token count API expects the upcoming message as part of the
        // history, so append the final user message that will be sent next.
        countContents.push({ role: 'user', parts: lastMessageParts });

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

    this.logger.debug(
      `CreateResponse chatParams: ${JSON.stringify(chatParams, null, 2)}`,
    );

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
          message: lastMessageParts,
          config: { ...generationConfig, abortSignal: signal },
        };
        const stream = await chat.sendMessageStream(streamParams);

        const fullParts: Part[] = [];
        let lastCandidate: any;
        let finalUsage: GenerateContentResponseUsageMetadata | undefined;
        const finalResponse = new GenerateContentResponse();
        for await (const chunk of stream) {
          if (chunk.candidates?.[0]) {
            lastCandidate = chunk.candidates[0];
            if (chunk.candidates[0].content?.parts) {
              fullParts.push(...chunk.candidates[0].content.parts);
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

        return finalResponse;
      }

      const sendParams: SendMessageParameters = {
        message: lastMessageParts,
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
    systemPrompt?: string,
  ): Promise<any[]> {
    const client = await this.getClient();
    const userContentParts: InternalMessagePart[] = [
      { type: 'text', text: userPrefix },
    ];

    if (
      mediaFiles &&
      mediaFiles.length > 0 &&
      (this.config.capabilities.supportsVision ||
        this.config.capabilities.supportsNativeAudio)
    ) {
      this.logger.debug(
        `Uploading ${mediaFiles.length} media files via native SDK...`,
      );
      const mediaFileResults: Array<{ path: string; ok: boolean }> = [];

      for (const mediaFile of mediaFiles) {
        try {
          const absolutePath = WorkspaceFS.fullPath(mediaFile);
          if (!(await AbsoluteFS.exists(absolutePath))) {
            this.logger.error(`File does not exist: ${absolutePath}`);
            mediaFileResults.push({ path: mediaFile, ok: false });
            continue;
          }

          const explicitMimeType = this.determineMimeType(absolutePath);

          if (!explicitMimeType) {
            this.logger.error(
              `Cannot determine mime type for ${mediaFile}. Skipping file.`,
            );
            mediaFileResults.push({ path: mediaFile, ok: false });
            continue;
          }

          const uploadParams: UploadFileParameters = {
            file: absolutePath,
            config: { mimeType: explicitMimeType },
          };

          this.logger.debug(
            `Attempting upload for ${mediaFile} with params: ${JSON.stringify(uploadParams)}`,
          );

          const uploadResult: File = await client.files.upload(uploadParams);

          this.logger.debug(
            `Uploaded ${mediaFile}, URI: ${uploadResult.uri}, MimeType: ${uploadResult.mimeType}`,
          );

          userContentParts.push({
            type: 'text',
            text: `\nFile attached: ${path.basename(mediaFile)}`,
          });
          userContentParts.push({
            type: 'file_uri',
            uri: uploadResult.uri,
            mimeType: uploadResult.mimeType,
          });
          mediaFileResults.push({ path: mediaFile, ok: true });
        } catch (error) {
          this.logger.error(
            `Failed to upload media file ${mediaFile} via native SDK: ${getSdkErrorMessage(error)}`,
            undefined,
            undefined,
            error,
          );
          mediaFileResults.push({ path: mediaFile, ok: false });
        }
      }

      if (mediaFileResults.length > 0) {
        if (mediaFileResults.some((r) => !r.ok)) {
          this.logger.warn('Some media files failed to load');
        }
        this.logger.fileList(mediaFileResults);
      }
    }

    userContentParts.push({ type: 'text', text: `\n${userRequest}` });

    return [{ role: 'user', content: userContentParts }];
  }

  private determineMimeType(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    this.logger.debug(
      `Determining MIME type for extension: '${ext}' from file: ${filePath}`,
    );

    const mimeType = getMimeType(filePath);
    if (!mimeType) {
      this.logger.warn(
        `Cannot determine mime type for ${filePath} from extension '${ext}'.`,
      );
    } else {
      this.logger.debug(
        `Determined MIME type: ${mimeType} for file: ${filePath}`,
      );
    }
    return mimeType;
  }

  /** Creates message array for subsequent rounds, managing image content and message structure. */
  async createRoundMessages(
    messages: Message[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<Message[]> {
    const client = await this.getClient();
    const roundParts: InternalMessagePart[] = [];

    if (
      mediaFiles &&
      mediaFiles.length > 0 &&
      (this.config.capabilities.supportsVision ||
        this.config.capabilities.supportsNativeAudio)
    ) {
      this.logger.debug(
        `Uploading ${mediaFiles.length} media files for reflection via native SDK...`,
      );
      const mediaFileResults: Array<{ path: string; ok: boolean }> = [];

      for (const mediaFile of mediaFiles) {
        try {
          const absolutePath = WorkspaceFS.fullPath(mediaFile);
          if (!(await AbsoluteFS.exists(absolutePath))) {
            this.logger.error(`File does not exist: ${absolutePath}`);
            mediaFileResults.push({ path: mediaFile, ok: false });
            continue;
          }

          const explicitMimeType = this.determineMimeType(absolutePath);

          if (!explicitMimeType) {
            this.logger.error(
              `Cannot determine mime type for file ${mediaFile}. Skipping file.`,
            );
            mediaFileResults.push({ path: mediaFile, ok: false });
            continue;
          }

          const uploadParams: UploadFileParameters = {
            file: absolutePath,
            config: { mimeType: explicitMimeType },
          };

          this.logger.debug(
            `Attempting upload for ${mediaFile} with params: ${JSON.stringify(uploadParams)}`,
          );
          this.logger.debug(`MIME type being used: ${explicitMimeType}`);

          const uploadResult: File = await client.files.upload(uploadParams);

          this.logger.debug(
            `Uploaded reflection file ${mediaFile}, URI: ${uploadResult.uri}, MimeType: ${uploadResult.mimeType}`,
          );

          if (!uploadResult.uri || !uploadResult.mimeType) {
            this.logger.error(
              `Upload result for file ${mediaFile} missing URI or MimeType. API might have failed inference. Skipping file.`,
            );
            mediaFileResults.push({ path: mediaFile, ok: false });
            continue;
          }

          roundParts.push({
            type: 'text',
            text: `\nProcessing file: ${path.basename(mediaFile)}`,
          });
          roundParts.push({
            type: 'file_uri',
            uri: uploadResult.uri,
            mimeType: uploadResult.mimeType,
          });
          mediaFileResults.push({ path: mediaFile, ok: true });
        } catch (error) {
          this.logger.error(
            `Failed to upload media file ${mediaFile} for follow-up round: ${getSdkErrorMessage(error)}`,
            undefined,
            undefined,
            error,
          );
          mediaFileResults.push({ path: mediaFile, ok: false });
        }
      }

      if (mediaFileResults.length > 0) {
        if (mediaFileResults.some((r) => !r.ok)) {
          this.logger.warn('Some media files failed to load');
        }
        this.logger.fileList(mediaFileResults);
      }
    }

    roundParts.push({ type: 'text', text: userMessage });

    messages.push({ role: 'user', content: roundParts });
    return messages;
  }

  async createUserFollowUpMessages(
    messages: Message[],
    userMessage: string,
  ): Promise<Message[]> {
    messages.push({ role: 'user', parts: [{ text: userMessage }] });
    return messages;
  }

  createAssistantMessage(text: string): Message {
    return { role: 'model', parts: [{ text }] };
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

    let responseText = '';
    if (candidate?.content?.parts) {
      responseText = candidate.content.parts
        .filter((part) => !!part.text)
        .map((part: Part) => part.text ?? '')
        .join('')
        .trim();
    } else {
      this.logger.warn(
        'Candidate content or parts missing in response object.',
      );
    }

    responseText = replacementEngine.applyAll(responseText);

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
    this.logger.warn(
      "Native Google SDK handler does not support assistant prefill continuation. Using 'WithoutPrefill'.",
    );
  }

  addContinueMessageWithoutPrefill(
    messages: Message[],
    _stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    const prefillTokens = toolState.lastResponse.slice(-K_SLICE);
    const userMessageContinuation = `Your response got cut off. Continue responding exactly where you left off, starting after: "${prefillTokens}". Do not repeat yourself or start over. Ensure you end with ${agentSetting.endTag}.`;
    this.logger.debug(`Adding continuation message.`);
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: userMessageContinuation }],
    });
  }

  updateMessageContentWithPrefill(/* ... */): void {
    this.logger.warn(
      "Native Google SDK handler does not support assistant prefill update. Using 'WithoutPrefill'.",
    );
  }

  updateMessageContentWithoutPrefill(
    messages: Message[],
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
      lastMessage.content &&
      this.containCutOffMessage(lastMessage.content)
    ) {
      messages.pop();
      this.logger.debug('Removed user continuation prompt.');
    }

    const modelMessage = messages.at(-1);
    if (modelMessage?.role === 'assistant') {
      if (Array.isArray(modelMessage.content)) {
        let lastTextPart = null;
        for (let i = modelMessage.content.length - 1; i >= 0; i--) {
          if (
            modelMessage.content[i] &&
            modelMessage.content[i].type === 'text'
          ) {
            lastTextPart = modelMessage.content[i];
            break;
          }
        }
        if (lastTextPart) {
          lastTextPart.text =
            (lastTextPart.text || '') + bestConnector + newResponse;
        } else {
          modelMessage.content.push({
            type: 'text',
            text: bestConnector + newResponse,
          });
          this.logger.warn(
            'Added new text part to last model message as none existed.',
          );
        }
      } else {
        modelMessage.content = [
          { type: 'text', text: toolState.accumulatedOutput },
        ];
        this.logger.error(
          'Last model message content was not an array. Resetting content.',
        );
      }
    } else {
      this.logger.debug('Adding new model message for the response.');
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: toolState.accumulatedOutput }],
      });
    }
  }

  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: Message[],
    toolState: ToolState,
    outputFile: string,
    prefill: string,
    groupId?: string,
  ): Promise<[boolean, Message[]]> {
    let endTurn = false;
    this.logger.debug(
      `Initializing output and prefill for ${outputFile}. Prefill content: "${prefill.slice(0, 100)}..."`,
    );

    if (!(await WorkspaceFS.existsAndNonTrivial(outputFile))) {
      this.logger.debug(
        `Output file ${outputFile} does not exist or is empty.`,
      );
      if (
        agentConfig.toolConfig.usePrefillFromInput &&
        toolState.firstKCharsFromInput
      ) {
        prefill = `<${agentSetting.documentTag}>${toolState.firstKCharsFromInput}`;
        toolState.updateAccumulatedOutput(prefill);
        this.logger.debug(
          `Using prefill from input file, updated prefill and toolState.`,
        );
      } else {
        toolState.updateAccumulatedOutput(prefill);
        // this.logger.debug(`Using standard prefill, updated toolState.`);
      }

      // Add pseudo-prefill instruction instead of skipping it
      const lastMessage = messages[messages.length - 1];
      const pseudoPrefillMsg = `Organize your response with XML tags. Start your response with:\n${prefill}`;

      if (lastMessage) {
        if (Array.isArray(lastMessage.content)) {
          lastMessage.content.push({ type: 'text', text: pseudoPrefillMsg });
        } else {
          lastMessage.content = [{ type: 'text', text: pseudoPrefillMsg }];
        }
      } else {
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: pseudoPrefillMsg }],
        });
      }

      this.logger.debug(`Added pseudo-prefill message: "${pseudoPrefillMsg}"`);
      return [endTurn, messages];
    }

    this.logger.debug(
      `Output file ${outputFile} exists and is non-trivial. Reading content.`,
    );
    let fileContent = await WorkspaceFS.readFile(outputFile);
    fileContent = cleanFileContent(fileContent);

    // Extract any existing scratchpad content
    const scratchpad = await xmlUtils.extractScratchpad(
      fileContent,
      'scratchpad',
    );
    if (scratchpad) {
      this.logger.info(scratchpad, groupId, MESSAGE_TYPES.SCRATCHPAD);
    }

    await WorkspaceFS.writeFile(outputFile, fileContent);
    this.logger.debug(`Cleaned and saved existing content to ${outputFile}.`);
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: fileContent }],
    });
    this.logger.debug(
      `Added existing file content to messages as 'assistant' role.`,
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

    const thoughtParts: Part[] = parts.filter(
      (p: Part) => p.thought && typeof p.text === 'string',
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
        thinking: p.text ?? '',
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
      const funcPart = parts.find((p: any) => p.functionCall);
      if (funcPart) {
        return JSON.stringify(funcPart.functionCall, null, 2);
      }
    }
    return null;
  }

  createToolUseFollowUpMessages(
    id: string,
    name: string,
    call: any,
    result: Record<string, unknown>,
    _toolState?: ToolState,
    text?: string,
  ): any[] {
    const callPart = createPartFromFunctionCall(
      name,
      typeof call?.args === 'object' ? call.args : (call?.input ?? {}),
    );
    if (callPart.functionCall) {
      callPart.functionCall.id = id;
    }
    const resultPart = createPartFromFunctionResponse(id, name, result);
    const callParts: Part[] = [];
    if (text) {
      callParts.push({ text });
    }
    callParts.push(callPart);
    const callMsg: Content = { role: 'assistant', parts: callParts };
    const resultMsg: Content = { role: 'user', parts: [resultPart] };
    return [callMsg, resultMsg];
  }

  // Assuming containCutOffMessage is available from base class ModelHandler
}
