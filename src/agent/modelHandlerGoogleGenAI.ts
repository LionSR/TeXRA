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
} from '@google/genai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { CompletionUsage } from 'openai/resources/completions';
import { GenerateContentResponseUsageMetadata } from '@google/genai/dist/node/node';

// Local imports - agent components
import { ModelHandler } from './ModelHandler';
import { AgentConfig } from './AgentConfig';
import { AgentSetting, hasEndTag } from './AgentDataclass';
import { AgentStateRound } from './AgentState';
import { ToolState } from './ToolState';
import { OpenAIAPIResponseUsage, ResponseUsageFactory } from './ResponseUsage';
import { MediaEntry } from './mediaTypes';

// Local imports - utilities
import {
  readFile,
  writeFile,
  fileExistsAndNonTrivial,
  getFullPathFromWorkspace,
} from '../utils/workspaceFileUtils';
import { fileExistsAbsolute } from '../utils/absoluteFileUtils';
import {
  applyReplacements,
  getAllReplacements,
  getAllReplacementsRegex,
  cleanFileContent,
} from '../replacement/replacementUtils';
import { extractAndLogScratchpad } from '../utils/xmlUtils';
import { getConfig } from '../utils/configUtils';
import { calculateTokenPrice } from '../utils/priceUtils';

// Local constant
import { K_SLICE } from '../utils/constants';
import {
  appendToLastMessage,
  appendContentToLastMessage,
  updateLastTextPart,
  getMessageAt,
} from '../utils/messageContentUtils';

// No need for custom types - use native Google GenAI Part type directly

// Helper function to convert OpenAI messages to Google GenAI Content format
function convertMessagesToGoogleContentHistory(
  messages: ChatCompletionMessageParam[],
  logger: any,
): Content[] {
  const history: Content[] = [];
  let currentRole: 'user' | 'model' | null = null;
  let currentParts: Part[] = [];

  messages.forEach((msg) => {
    const role =
      msg.role === 'assistant' ? 'model' : msg.role === 'user' ? 'user' : null;
    if (!role) return;

    let parts: Part[] = [];
    if (Array.isArray(msg.content)) {
      parts = msg.content
        .map((part: any): Part | null => {
          // Native Google Part format (from our own messages)
          if (part.text !== undefined) {
            return { text: part.text };
          } else if (part.fileData) {
            return { fileData: part.fileData };
          }
          // OpenAI text format (from other handlers)
          else if (part.type === 'text' && typeof part.text === 'string') {
            return { text: part.text };
          }
          // Handle image URLs by skipping (Google needs file URIs)
          else if (part.type === 'image_url') {
            logger.warn('Image URLs not supported by Google GenAI - skipping');
            return null;
          } else {
            logger.warn(`Skipping unsupported part: ${JSON.stringify(part)}`);
            return null;
          }
        })
        .filter((part: Part | null): part is Part => part != null);
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
export class ModelHandlerGoogleGenAI extends ModelHandler {
  private googleClient: GoogleGenAI | null = null;

  async getClient(): Promise<GoogleGenAI> {
    if (!this.googleClient) {
      const apiKey = await this.getApiKey();
      this.logger.debug(`Using Google GenAI Native SDK.`);
      this.googleClient = new GoogleGenAI({ apiKey });
    }
    return this.googleClient;
  }

  /** Creates a chat completion response using Google's GenAI API with specified parameters and optional system prompt. */
  async createResponse(
    client: GoogleGenAI,
    messages: ChatCompletionMessageParam[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
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
    if (lastMessage?.content) {
      if (Array.isArray(lastMessage.content)) {
        // Convert content array to Google Parts
        lastMessageParts = lastMessage.content
          .map((part: any): Part | null => {
            if (part.text !== undefined) {
              return { text: part.text };
            } else if (part.fileData) {
              return { fileData: part.fileData };
            } else {
              this.logger.warn(
                `Skipping unsupported part in sendMessage: ${JSON.stringify(part)}`,
              );
              return null;
            }
          })
          .filter((part): part is Part => part !== null);
      } else if (typeof lastMessage.content === 'string') {
        lastMessageParts = [{ text: lastMessage.content }];
      }
    }
    if (lastMessageParts.length === 0) {
      this.logger.error('Could not extract valid parts from the last message.');
      throw new Error('Last message conversion resulted in empty parts.');
    }

    const generationConfig = {
      temperature: temperature,
      maxOutputTokens: this.config.maxOutputTokens,
      ...(endTag && { stopSequences: [endTag] }),
    };

    const chatParams = {
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
          generationConfig.maxOutputTokens
        ) {
          this.logger.warn(
            `Token count of message plus max tokens exceeds context window: ${totalTokens} + ${generationConfig.maxOutputTokens} > ${this.config.contextWindow}. Reducing max tokens to ${this.config.contextWindow - totalTokens}.`,
          );
          generationConfig.maxOutputTokens =
            this.config.contextWindow - totalTokens - 10;
        }
      } catch (err: any) {
        this.logger.error(
          `Token counting failed: ${err.message}. Proceeding without token adjustment.`,
        );
      }
    }

    if (getConfig<boolean>('model.useStreaming', false)) {
      this.logger.warn(
        'Streaming is configured but currently disabled in ModelHandlerGoogleGenAI (using Chat API).',
      );
    }

    try {
      this.logger.debug(
        `Creating chat session with history length: ${chatHistory.length}`,
      );
      const chat = client.chats.create(chatParams);

      this.logger.debug(
        `Sending message with ${lastMessageParts.length} parts.`,
      );
      const result = await chat.sendMessage({ message: lastMessageParts });

      return result;
    } catch (error: any) {
      this.logger.error(
        `Error during Google GenAI Chat API call: ${error?.message || error}`,
      );
      this.logger.error(error.message);
      if (error.message?.includes('request.contents[0].parts')) {
        this.logger.error(
          'Potential issue with sendMessage parameter structure. Check conversion.',
        );
      }
      if (error.message?.includes('SAFETY')) {
        this.logger.error(
          `Safety block details: ${JSON.stringify(error.response?.promptFeedback)}`,
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
  ): Promise<ChatCompletionMessageParam[]> {
    const client = await this.getClient();
    const userContentParts: Part[] = [{ text: userPrefix }];

    if (
      mediaFiles &&
      mediaFiles.length > 0 &&
      (this.config.capabilities.supportsVision ||
        this.config.capabilities.supportsNativeAudio)
    ) {
      this.logger.info(
        `Uploading ${mediaFiles.length} media files via native SDK...`,
      );
      for (const mediaFile of mediaFiles) {
        try {
          const absolutePath = getFullPathFromWorkspace(mediaFile);
          if (!fileExistsAbsolute(absolutePath)) {
            this.logger.error(`File does not exist: ${absolutePath}`);
            continue;
          }

          const explicitMimeType = this.determineMimeType(absolutePath);

          if (!explicitMimeType) {
            this.logger.error(
              `Cannot determine mime type for ${mediaFile}. Skipping file.`,
            );
            continue;
          }

          const uploadParams = {
            file: absolutePath,
            config: { mimeType: explicitMimeType },
          };

          this.logger.debug(
            `Attempting upload for ${mediaFile} with params: ${JSON.stringify(uploadParams)}`,
          );

          const uploadResult: File = await client.files.upload(uploadParams);

          this.logger.info(
            `Uploaded ${mediaFile}, URI: ${uploadResult.uri}, MimeType: ${uploadResult.mimeType}`,
          );

          userContentParts.push({
            text: `\nFile attached: ${path.basename(mediaFile)}`,
          });
          if (uploadResult.uri && uploadResult.mimeType) {
            userContentParts.push({
              fileData: {
                fileUri: uploadResult.uri,
                mimeType: uploadResult.mimeType,
              },
            });
          } else {
            this.logger.error(
              `Upload result missing URI or MIME type for ${mediaFile}`,
            );
          }
        } catch (error) {
          this.logger.error(
            `Failed to upload media file ${mediaFile} via native SDK: ${error}`,
          );
        }
      }
    }

    userContentParts.push({ text: `\n${userRequest}` });

    return [{ role: 'user', content: userContentParts as any }];
  }

  private determineMimeType(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    this.logger.debug(
      `Determining MIME type for extension: '${ext}' from file: ${filePath}`,
    );

    // TODO: this map/function can be put somewhere else to be more DRY and reusable
    const mimeMap: { [key: string]: string } = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.heic': 'image/heic',
      '.heif': 'image/heif',
      '.gif': 'image/gif',
      '.pdf': 'application/pdf',
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
      '.oga': 'audio/ogg',
      '.flac': 'audio/flac',
      '.opus': 'audio/opus',
      '.m4a': 'audio/m4a',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.webm': 'video/webm',
      '.mpeg': 'video/mpeg',
    };
    const mimeType = mimeMap[ext];
    if (!mimeType) {
      this.logger.warn(
        `Cannot determine mime type for ${filePath} from extension '${ext}'.`,
      );
    } else {
      this.logger.debug(
        `Determined MIME type: ${mimeType} for file: ${filePath}`,
      );
    }
    return mimeType || null;
  }

  /** Creates a reflection message array for Google GenAI models, managing image content and message structure. */
  async createReflectionMessages(
    messages: ChatCompletionMessageParam[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<ChatCompletionMessageParam[]> {
    const client = await this.getClient();
    const reflectionParts: Part[] = [];

    if (
      mediaFiles &&
      mediaFiles.length > 0 &&
      (this.config.capabilities.supportsVision ||
        this.config.capabilities.supportsNativeAudio)
    ) {
      this.logger.info(
        `Uploading ${mediaFiles.length} media files for reflection via native SDK...`,
      );
      for (const mediaFile of mediaFiles) {
        try {
          const absolutePath = getFullPathFromWorkspace(mediaFile);
          if (!fileExistsAbsolute(absolutePath)) {
            this.logger.error(`File does not exist: ${absolutePath}`);
            continue;
          }

          const explicitMimeType = this.determineMimeType(absolutePath);

          if (!explicitMimeType) {
            this.logger.error(
              `Cannot determine mime type for reflection file ${mediaFile}. Skipping file.`,
            );
            continue;
          }

          const uploadParams = {
            file: absolutePath,
            config: { mimeType: explicitMimeType },
          };

          this.logger.debug(
            `Attempting reflection upload for ${mediaFile} with params: ${JSON.stringify(uploadParams)}`,
          );
          this.logger.debug(`MIME type being used: ${explicitMimeType}`);

          const uploadResult: File = await client.files.upload(uploadParams);

          this.logger.info(
            `Uploaded reflection file ${mediaFile}, URI: ${uploadResult.uri}, MimeType: ${uploadResult.mimeType}`,
          );

          if (!uploadResult.uri || !uploadResult.mimeType) {
            this.logger.error(
              `Upload result for reflection file ${mediaFile} missing URI or MimeType. API might have failed inference. Skipping file.`,
            );
            continue;
          }

          reflectionParts.push({
            text: `\nReflecting on file: ${path.basename(mediaFile)}`,
          });
          if (uploadResult.uri && uploadResult.mimeType) {
            reflectionParts.push({
              fileData: {
                fileUri: uploadResult.uri,
                mimeType: uploadResult.mimeType,
              },
            });
          }
        } catch (error) {
          this.logger.error(
            `Failed to upload media file ${mediaFile} for reflection: ${error}`,
          );
        }
      }
    }

    reflectionParts.push({ text: userMessage });

    messages.push({ role: 'user', content: reflectionParts as any });
    return messages;
  }

  createMediaContent(mediaMessage: MediaEntry[]): any[] {
    this.logger.warn(
      'createMediaContent called on ModelHandlerGoogleGenAI - should be obsolete.',
    );
    return mediaMessage;
  }

  extractResponse(
    responseObject: GenerateContentResponse,
    endTag: string,
  ): [string, any, string] {
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

    responseText = applyReplacements(responseText, getAllReplacements()).trim();
    responseText = applyReplacements(
      responseText,
      getAllReplacementsRegex(),
    ).trim();

    const usage = responseObject.usageMetadata;
    const stopReason: FinishReason =
      candidate?.finishReason ?? FinishReason.FINISH_REASON_UNSPECIFIED;

    // If the model stopped naturally but didn't include the end tag, append it
    if (
      stopReason === FinishReason.STOP &&
      endTag &&
      !responseText.endsWith(endTag)
    ) {
      this.logger.info(
        `Model stopped naturally but didn't include end tag. Appending ${endTag}.`,
      );
      responseText += `\n${endTag}`;
    }

    return [responseText, usage, stopReason];
  }

  computePrice(responseUsage: GenerateContentResponseUsageMetadata): number {
    if (!responseUsage) return 0.0;
    const promptTokens = responseUsage.promptTokenCount ?? 0;
    const completionTokens = responseUsage.candidatesTokenCount ?? 0;
    const thoughtTokens = responseUsage.thoughtsTokenCount ?? 0;
    // Keep toolUseTokenCount for future use even if the type doesn't have it yet
    const toolUseTokens = (responseUsage as any).toolUseTokenCount ?? 0;
    return calculateTokenPrice(
      promptTokens,
      completionTokens + thoughtTokens + toolUseTokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );
  }

  computeResponseUsage(
    responseUsage: GenerateContentResponseUsageMetadata,
    responseTime: number,
  ): OpenAIAPIResponseUsage {
    const usageObj: CompletionUsage = {
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
    messages: ChatCompletionMessageParam[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void {
    const prefillTokens = toolState.lastResponse.slice(-K_SLICE);
    const userMessageContinuation = `Your response got cut off. Continue responding exactly where you left off, starting after: "${prefillTokens}". Do not repeat yourself or start over. Ensure you end with ${agentSetting.endTag}.`;
    this.logger.info(`Adding continuation message.`);
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
    messages: ChatCompletionMessageParam[],
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
      this.containCutOffMessage(lastMessage.content)
    ) {
      messages.pop();
      this.logger.debug('Removed user continuation prompt.');
    }

    const modelMessage = getMessageAt(messages, -1);
    if (modelMessage?.role === 'assistant') {
      // Use unified function to update last text part
      const updated = updateLastTextPart(
        modelMessage,
        (text) => text + bestConnector + newResponse,
        'google',
      );

      if (!updated) {
        // If no text part found, append new one using unified function
        appendContentToLastMessage(
          messages,
          { text: bestConnector + newResponse },
          'google',
        );
        this.logger.warn(
          'Added new text part to last model message as none existed.',
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
    messages: ChatCompletionMessageParam[],
    toolState: ToolState,
    outputFile: string,
    prefill: string,
    groupId?: string,
  ): Promise<[boolean, ChatCompletionMessageParam[]]> {
    let endTurn = false;
    this.logger.debug(
      `Initializing output and prefill for ${outputFile}. Prefill content: "${prefill.slice(0, 100)}..."`,
    );

    if (!(await fileExistsAndNonTrivial(outputFile))) {
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
      const pseudoPrefillMsg = `Organize your response with XML tags. Start your response with:\n${prefill}`;

      if (!appendToLastMessage(messages, pseudoPrefillMsg, 'google')) {
        this.logger.warn('Failed to append pseudo-prefill message');
      }

      this.logger.debug(`Added pseudo-prefill message: "${pseudoPrefillMsg}"`);
      return [endTurn, messages];
    }

    this.logger.info(
      `Output file ${outputFile} exists and is non-trivial. Reading content.`,
    );
    let fileContent = await readFile(outputFile);
    fileContent = cleanFileContent(fileContent);

    // Extract and log any existing scratchpad content
    extractAndLogScratchpad(fileContent, this.logger, 'scratchpad', groupId);

    await writeFile(outputFile, fileContent);
    this.logger.debug(`Cleaned and saved existing content to ${outputFile}.`);
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: fileContent }],
    });
    this.logger.debug(
      `Added existing file content to messages as 'assistant' role.`,
    );

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.info(
        'End tag detected in existing file content - skipping generation.',
      );
      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.info(
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
    stopReason: string,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    const hitTokenLimit =
      stopReason === FinishReason.MAX_TOKENS || stopReason === 'MAX_TOKENS';
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
    responseObject: any,
    groupId?: string,
    toolState?: ToolState,
  ): string | null {
    this.logger.debug(
      'processThinkingBlock: Native Google SDK does not expose thinking process via API response. Returning null.',
    );
    return null;
  }

  // Assuming containCutOffMessage is available from base class ModelHandler
}
