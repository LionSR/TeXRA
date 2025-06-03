// Standard library imports
// (none needed)

// Third-party imports
import OpenAI, {
  RateLimitError,
  NotFoundError,
  PermissionDeniedError,
} from 'openai';
import { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import { countTokens } from 'gpt-tokenizer';

// Local imports - utilities
import {
  readFile,
  writeFile,
  fileExistsAndNonTrivial,
} from '../utils/workspaceFileUtils';
import { cleanFileContent } from '../replacement/replacementUtils';
import { getConfig } from '../utils/configUtils';
import { extractAndLogScratchpad } from '../utils/xmlUtils';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSetting, hasEndTag } from './AgentDataclass';
import { AgentStateRound } from './AgentState';
import { ModelHandler } from './ModelHandler';
import {
  OpenAIAPIResponseUsage,
  ResponseUsageFactory,
  ExtendedCompletionUsage,
} from './ResponseUsage';
import { ToolState } from './ToolState';
import { K_SLICE } from '../utils/constants';
import { objectToLogString } from '../utils/stringUtils';
import { calculateTokenPrice } from '../utils/priceUtils';
import { MediaEntry } from './mediaTypes';
import { ProgressViewProvider } from '../progressView/ProgressViewProvider';

/**
 * OpenAI-specific handlers.
 */
export class ModelHandlerOpenAI extends ModelHandler {
  /** Returns OpenAI client with configured API key. */
  async getClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl();
    this.logger.debug('Using OpenAI API.');

    // there is a time out parameter that be be set; default is 10 minutes
    return new OpenAI({ apiKey, baseURL });
  }

  /** Creates a chat completion with model-specific parameters. */
  async createResponse(
    client: OpenAI,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    signal?: AbortSignal,
    groupId?: string,
  ): Promise<any> {
    // Get streaming config
    const useStreaming = this.getStreamingConfig();

    const kwargs: any = {
      model: this.config.fullName,
      messages,
      [this.isOReasoningModel ? 'max_completion_tokens' : 'max_tokens']:
        this.config.maxOutputTokens,
    };
    if (!this.isOReasoningModel) {
      if (endTag) {
        kwargs.stop = [endTag];
      }
      kwargs.temperature = temperature;
    }
    if (this.config.capabilities.supportsReasoning) {
      if (
        this.config.capabilities.supportsReasoningEffort &&
        this.config.capabilities.reasoningEffort
      ) {
        // Validate reasoning effort based on provider-specific constraints
        kwargs.reasoning_effort = this.validateReasoningEffort(
          this.config.capabilities.reasoningEffort,
        );
      }
    }
    if (this.config.fullName.includes('deepseek')) {
      // for deepseek models,  this and context window are not the same for openrouter models and the official api. so we need to set max_tokens manually if the official api is used
      this.logger.debug('Setting max_tokens to 8192 for DeepSeek models');
      kwargs.max_tokens = 8192;
    }

    // Calculate input tokens using the helper method
    try {
      const approximateInputTokens = this._calculateApproximateTokens(
        messages,
        systemPrompt,
      );

      this.logger.debug(
        `Approximate token count of message: ${approximateInputTokens}`,
      );

      if (approximateInputTokens > this.config.contextWindow) {
        const errorMsg = `Approximate token count of message exceeds context window: ${approximateInputTokens} > ${this.config.contextWindow}`;
        this.logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      const maxOutputKey = this.isOReasoningModel
        ? 'max_completion_tokens'
        : 'max_tokens';
      if (
        this.config.contextWindow - approximateInputTokens <
        kwargs[maxOutputKey]
      ) {
        const originalMaxTokens = kwargs[maxOutputKey];
        kwargs[maxOutputKey] =
          this.config.contextWindow - approximateInputTokens - 5000; // Add a small buffer
        this.logger.warn(
          `Approximate token count (${approximateInputTokens}) + max tokens (${originalMaxTokens}) exceeds context window (${this.config.contextWindow}). Reducing max tokens to ${kwargs[maxOutputKey]}.`,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `Token counting failed: ${err.message}. Proceeding without token adjustment.`,
      );
      // Decide if you want to throw here or let the API call potentially fail
    }

    if (useStreaming) {
      let response: any;
      kwargs.stream_options = { include_usage: true };
      
      // Get the progress view provider for streaming updates
      const progressView = ProgressViewProvider.getInstance();
      const streamId = this.logger.channelId;

      // Signal start of streaming
      if (progressView && groupId) {
        progressView.startStreaming(streamId, groupId);
      }

      try {
        const stream = client.chat.completions.stream(kwargs, {
          signal,
        });

        let accumulatedContent = '';
        let accumulatedReasoning = '';
        let reasoningState = 'not-started';

        // Add streaming event handlers for real-time updates
        stream.on('content', (delta: string, snapshot: string) => {
          if (progressView && groupId) {
            if (reasoningState !== 'finished') {
              reasoningState = 'finished';
            }
            // Send only the new delta to avoid duplication
            if (delta) {
              progressView.addStreamingText(streamId, delta, groupId);
            }
          }
        });

        // Handle reasoning content for O1 and reasoning models
        if (this.config.capabilities.supportsReasoning) {
          stream.on('content.reasoning', (delta: string, snapshot: string) => {
            if (progressView && groupId) {
              if (reasoningState === 'not-started') {
                reasoningState = 'started';
              }
              // Send only the new delta to avoid duplication
              if (delta) {
                progressView.addStreamingThinking(streamId, delta, groupId);
              }
            }
          });
        }

        stream.on('end', () => {
          if (progressView && groupId) {
            progressView.endStreaming(streamId, groupId);
          }
        });

        response = await stream.finalMessage();

        // in the future we can add: stream_options: {"include_usage": true} to get usage statistics
        // in the future if we pass stream to outside (signal: controller.signal)), calling stream.controller.abort() will abort the stream; which will be very useful for our stop button (controller.abort();)
        // we should also make sure partial results can be returned in the presence of errors!
      } catch (err) {
        if (progressView && groupId) {
          progressView.endStreaming(streamId, groupId);
        }
        if (
          err instanceof NotFoundError ||
          err instanceof RateLimitError ||
          err instanceof PermissionDeniedError
        ) {
          throw err;
        }
        this.logger.error(`Error in createResponse(streaming): ${err}`);
      }
      return response;
    } else {
      try {
        const response = await client.chat.completions.create(kwargs, {
          signal,
        });
        return response;
      } catch (err) {
        this.logger.error(`Error in createResponse: ${err}`);
        throw err;
      }
    }
  }

  /** Initializes message array with system prompt and user content. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: string[],
    systemPrompt?: string,
  ): Promise<any[]> {
    const messages: any[] = [];

    // Handle system prompt differently for O1 models
    if (systemPrompt) {
      if (this.config.capabilities.supportsSystemPrompt) {
        // note that for openai native o1 full or above reasoning models, they have been renamed to "developer" but "system" still works
        messages.push({
          role: 'system',
          content: [{ type: 'text', text: systemPrompt }],
        });
      } else {
        // e.g., O1 mini and O1 preview models do not support system prompt
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: systemPrompt }],
        });
      }
    }

    // Create content list for the user message
    const userMessageContent: ChatCompletionContentPart[] = [
      { type: 'text', text: userPrefix },
    ];

    // Add media if provided
    if (
      mediaFiles &&
      (this.config.capabilities.supportsVision ||
        this.config.capabilities.supportsNativeAudio)
    ) {
      // createMediaMessage returns an array of objects formatted by createMediaContent
      const formattedMediaContent = await this.createMediaMessage(mediaFiles);
      userMessageContent.push(...formattedMediaContent);
    }

    // Append the formatted content to the correct message
    let lastRole = messages.length > 0 ? messages.at(-1).role : null;
    if (lastRole === 'system' || messages.length === 0) {
      messages.push({ role: 'user', content: userMessageContent });
    } else if (lastRole === 'user') {
      messages.at(-1).content.push(...userMessageContent);
    } else {
      // Fallback: Should not happen with current logic but good to handle
      messages.push({ role: 'user', content: userMessageContent });
      this.logger.warn(
        'Unexpected message structure, adding new user message.',
      );
    }

    // Add final user request
    const requestRole = this.config.capabilities.supportsIntermDevMsgs
      ? 'system'
      : 'user';
    lastRole = messages.length > 0 ? messages.at(-1).role : null;

    if (requestRole === 'system') {
      messages.push({
        role: requestRole,
        content: [{ type: 'text', text: userRequest }],
      });
    } else if (requestRole === 'user' && lastRole === 'user') {
      messages.at(-1).content.push({
        type: 'text',
        text: userRequest,
      });
    } else {
      messages.push({
        role: requestRole,
        content: [{ type: 'text', text: userRequest }],
      });
    }

    return messages;
  }

  /** Adds user message with reflection content to existing messages. */
  async createReflectionMessages(
    messages: any[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<any[]> {
    const reflectionContent: ChatCompletionContentPart[] = [];

    // const role = this.config.capabilities.supportsIntermDevMsgs
    // ? 'system'
    // : 'user';
    // technically we can use system for the reflection messages, but it does not support images...
    // Error in createResponse: Error: 400 Invalid 'messages[4]'. Image URLs are only allowed for messages with role 'user', but this message with role 'system' contains an image URL.
    // system role does not support images/audio
    const role = 'user';

    if (
      mediaFiles &&
      mediaFiles.length > 0 &&
      (this.config.capabilities.supportsVision ||
        this.config.capabilities.supportsNativeAudio)
    ) {
      try {
        const formattedMediaContent = await this.createMediaMessage(mediaFiles);
        reflectionContent.push(...formattedMediaContent);
      } catch (err) {
        this.logger.error(
          `Error processing media files for reflection: ${err}`,
        );
      }
    }
    reflectionContent.push({ type: 'text', text: userMessage });

    messages.push({ role, content: reflectionContent });
    return messages;
  }

  /** Formats image/audio content for OpenAI/Google's vision/audio API. */
  createMediaContent(mediaMessage: MediaEntry[]): ChatCompletionContentPart[] {
    return mediaMessage.flatMap((media): ChatCompletionContentPart[] => {
      if (media.media_category === 'image') {
        return [
          { type: 'text', text: `Image: ${media.file_name}` },
          {
            type: 'image_url',
            image_url: {
              url: `data:${media.media_type};base64,${media.data}`,
              detail: 'high',
              // media_type and data are not standard OpenAI
              // Re-add them if needed for other providers (which is not the case for Google/OpenRouter)
            },
          },
        ];
      } else if (
        media.media_category === 'audio' &&
        this.isGoogle &&
        this.config.capabilities.supportsNativeAudio
      ) {
        // Currently only Google via OpenAI compatibility layer supports this
        let audioFormat = media.media_type;
        if (media.media_type.includes('/')) {
          audioFormat = media.media_type.split('/')[1]; // e.g., 'wav' from 'audio/wav'
        }
        // actually, currently only mp3 and wav are supported
        // openai.BadRequestError: Error code: 400 - [{'error': {'code': 400, 'message': 'Invalid audio format "m4a" for audio generation. Valid formats are: [wav, mp3]', 'status': 'INVALID_ARGUMENT'}}]

        // For the size:
        // You can use the File API to upload an audio file of any size.
        // Always use the File API when the total request size (including the files, text prompt, system instructions, etc.) is larger than 20 MB.
        // The maximum request size is 20 MB, which includes text prompts, system instructions, and files provided inline. If your file's size will make the total request size exceed 20 MB, then use the File API to upload files for use in requests.
        // If you're using an audio sample multiple times, it is more efficient to use the File API.
        // https://ai.google.dev/gemini-api/docs/audio?hl=en&lang=python

        // The structure below might need adjustment based on exact API requirements
        // Using a structure closer to the message format from documentation
        // It seems this needs to be part of the user message content directly.
        // Let's adapt this to return the structured object expected within the message content array.
        return [
          { type: 'text', text: `Audio: ${media.file_name}` }, // Text description goes separately
          {
            type: 'input_audio' as any, // Cast as any to bypass strict OpenAI typing for now
            input_audio: {
              data: media.data,
              format: audioFormat as any,
            },
          },
        ];
      } else if (media.media_category === 'audio') {
        this.logger.warn(
          `Audio input received (${media.file_name}) but native audio is not supported by this specific model/provider (${this.config.provider}). Skipping.`,
        );
        return []; // Return empty array if audio not supported
      } else {
        this.logger.warn(`Unknown media category: ${media.media_category}`);
        return [];
      }
    });
  }

  /** Extracts response text and usage statistics from API response. */
  extractResponse(responseObject: any, endTag: string): [string, any, string] {
    if (!responseObject.choices?.length) {
      this.logger.debug(
        `Response object: ${objectToLogString(responseObject)}`,
      );

      // Add fallback for streaming which returns content directly in responseObject
      if (responseObject.role && responseObject.content) {
        this.logger.info(
          'Using direct response format (streaming style) as fallback',
        );
        let newResponse = responseObject.content.trim();
        // Since we don't have a stop reason in this format, assume 'stop'
        let stopReason = 'stop';
        // let stopReason = 'length';
        if (responseObject.finish_reason) {
          stopReason = responseObject.finish_reason;
        }
        // if (responseObject.choices[0].finish_reason) {
        //   stopReason = responseObject.choices[0].finish_reason;
        // }

        // For usage, we'll use empty values since they're not provided
        const usage = responseObject.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
        };

        // Add end tag if response was stopped and tag isn't present
        if (stopReason === 'stop' && endTag && !newResponse.includes(endTag)) {
          this.logger.debug(`Adding end tag to response: ${endTag}`);
          newResponse = `${newResponse}\n${endTag}`;
        }

        return [newResponse, usage, stopReason];
      }

      if (responseObject.error) {
        const errorMsg = `API error: ${JSON.stringify(responseObject.error)}`;
        this.logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      const errorMsg = 'Invalid response from API: missing choices';
      this.logger.error(errorMsg);
      this.logger.error(
        `Response object: ${objectToLogString(responseObject)}`,
      );
      throw new Error(errorMsg);
    }

    // Extract base response
    const choice = responseObject.choices[0];
    const stopReason = choice.finish_reason;
    this.logger.info(`Stop reason: ${stopReason}`);
    let newResponse = '';
    if (choice.message.content) {
      newResponse = choice.message.content.trim();
    } else {
      newResponse = '';
      this.logger.error(
        `Response object: ${objectToLogString(responseObject)}`,
      );
      this.logger.error('content is empty');
    }

    // Add end tag if response was stopped and tag isn't present
    if (stopReason === 'stop' && endTag && !newResponse.includes(endTag)) {
      this.logger.debug(`Adding end tag to response: ${endTag}`);
      newResponse = `${newResponse}\n${endTag}`;
    }

    return [newResponse, responseObject.usage, stopReason];
  }

  /** Manages continuation with prefill support (typically no-op for models with prefill). */
  addContinueMessageWithPrefill(
    messages: any[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void {
    this.logger.debug('Skipping continuation - assistant prefill is supported');
    // No-op for models that support prefill
  }

  /** Manages continuation for models without prefill support by adding a continuation prompt. */
  addContinueMessageWithoutPrefill(
    messages: any[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void {
    // Create continuation message with last K tokens
    const prefillTokens = toolState.lastResponse.slice(-K_SLICE);
    const userMessageContinuation =
      `Your response got cut off, because you only have limited response space. ` +
      `Continue responding exactly from where you left off until the very end, ` +
      `marked by ${agentSetting.endTag}. ` +
      'Avoid repeat yourself and avoid starting over. ' +
      `Start your response at the next token after: "${prefillTokens}"`;

    // Add continuation message
    this.logger.info(
      `Adding continuation message to conversation. Continuation message:\n ${userMessageContinuation}`,
    );

    const role = this.config.capabilities.supportsIntermDevMsgs
      ? 'system'
      : 'user';
    messages.push({
      role,
      content: [{ type: 'text', text: userMessageContinuation }],
    });
  }

  /** Initializes output file and handles prefill content. */
  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: any[],
    toolState: ToolState,
    outputFile: string,
    prefill: string,
    groupId?: string,
  ): Promise<[boolean, any[]]> {
    let endTurn = false;

    if (!(await fileExistsAndNonTrivial(outputFile))) {
      if (
        agentConfig.toolConfig.usePrefillFromInput &&
        toolState.firstKCharsFromInput
      ) {
        prefill += toolState.firstKCharsFromInput;
        toolState.updateAccumulatedOutput('');
        prefill = `<${agentSetting.documentTag}>${toolState.firstKCharsFromInput}`;
      }

      const PseudoPrefillMsgContentString = `Organize your response with xml tags. Start your response with:\n${prefill}`;
      messages.at(-1).content.push({
        type: 'text',
        text: PseudoPrefillMsgContentString,
      });
      this.logger.debug(
        `Added pseudo prefill message to messages:\n${PseudoPrefillMsgContentString}`,
      );
      return [endTurn, messages];
    }

    // Get prefill from existing and non-trivial file
    let fileContent = await readFile(outputFile);
    fileContent = cleanFileContent(fileContent);

    // Extract and log any existing scratchpad content
    extractAndLogScratchpad(fileContent, this.logger, 'scratchpad', groupId);

    // Write file content to output file
    await writeFile(outputFile, fileContent);

    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: fileContent,
        },
      ],
    });

    const lastMessage = messages.at(-1);
    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.info('End tag detected - skipping continuation');
      if (Array.isArray(lastMessage.content)) {
        // this is suspicious, because the two conflicts!!!
        lastMessage.content[lastMessage.content.length - 1].text = fileContent;
      } else {
        lastMessage.content = [
          {
            type: 'text',
            text: fileContent,
          },
        ];
      }
      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.info(
      'Output file exists but no end tag found - continuing from file',
    );
    if (fileContent.includes(prefill)) {
      toolState.updateAccumulatedOutput(fileContent);
    } else {
      toolState.updateAccumulatedOutput(prefill + fileContent);
      await writeFile(outputFile, toolState.accumulatedOutput);
    }
    const state = new AgentStateRound(0);
    toolState.lastResponse = toolState.accumulatedOutput;
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

  /** Computes cost based on token usage and model pricing. */
  computePrice(responseUsage: ExtendedCompletionUsage | null): number {
    // Handle models that return None for usage
    if (!responseUsage) {
      return 0.0;
    }

    // Get token counts
    const promptTokens = responseUsage.prompt_tokens ?? 0;
    const completionTokens = responseUsage.completion_tokens ?? 0;
    // Note: OpenAI doesn't provide tool_use_tokens in their API response

    let basePrice = calculateTokenPrice(
      promptTokens,
      completionTokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );

    // Retrieve nested token details if present
    const reasoningTokens =
      responseUsage.completion_tokens_details?.reasoning_tokens ?? 0;
    const cachedTokens =
      responseUsage.prompt_tokens_details?.cached_tokens ??
      responseUsage.prompt_cache_hit_tokens ?? // deepseek
      0;

    if (reasoningTokens) {
      basePrice += (reasoningTokens * this.config.outputPrice) / 1e6;
    }
    if (cachedTokens) {
      basePrice -=
        (cachedTokens *
          this.config.inputPrice *
          (1 - this.capabilities.cacheDiscountFactor)) /
        1e6;
    }

    return basePrice;
  }

  /** Creates usage statistics from OpenAI's response format. */
  computeResponseUsage(
    responseUsage: ExtendedCompletionUsage | null,
    responseTime: number,
  ): OpenAIAPIResponseUsage {
    // For Google models, create a minimal usage object with zeros
    if (!responseUsage) {
      const emptyUsage: ExtendedCompletionUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        // Note: OpenAI doesn't provide tool_use_tokens, so we don't include it
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: {
          reasoning_tokens: 0,
          accepted_prediction_tokens: undefined,
          rejected_prediction_tokens: undefined,
        },
      };
      return ResponseUsageFactory.fromOpenAIResponse(
        emptyUsage,
        this.computePrice(responseUsage),
        responseTime,
      );
    }

    return ResponseUsageFactory.fromOpenAIResponse(
      responseUsage,
      this.computePrice(responseUsage),
      responseTime,
    );
  }

  /** Updates message content for models with prefill support. */
  updateMessageContentWithPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void {
    this.logger.debug(
      'Updating message content for OpenAI models with prefill support',
    );

    const lastMessage = messages.at(-1);

    if (lastMessage.role === 'assistant') {
      if (Array.isArray(lastMessage.content)) {
        const newMessage = {
          type: 'text',
          text: bestConnector + newResponse,
        };
        lastMessage.content.push(newMessage);
      } else {
        lastMessage.content = [
          {
            type: 'text',
            text: toolState.accumulatedOutput,
          },
        ];
      }
    } else if (lastMessage.role === 'user' || lastMessage.role === 'system') {
      this.logger.debug(
        ' Last message is a user or system message - unexpected format',
      );
      // Add a new assistant message
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: bestConnector + newResponse }],
      });
    }
  }

  /** Updates message content for models without prefill support. */
  updateMessageContentWithoutPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void {
    this.logger.debug(
      'Updating message content for OpenAI models without prefill support',
    );

    // For OpenAI models without prefill, the last message is always a user/system message
    const lastMessage = messages.at(-1);
    const secondLastMessage = messages.at(-2);

    if (lastMessage.role !== 'user' && lastMessage.role !== 'system') {
      this.logger.error(
        'Last message is not a user or system message - unexpected format',
      );
      return;
    }
    this.logger.debug('Last message is a user/system message');

    if (this.containCutOffMessage(lastMessage.content)) {
      this.logger.debug(
        'Last message is a user message asking to continue after cut off',
      );
      // Then the last message is a user message
      // So the second last message must be an assistant message
      if (secondLastMessage.role === 'assistant') {
        // we get gradually get rid if this kind of isArray conditioning since now we are consistently using the content array
        // but why do the following two differ?
        if (Array.isArray(secondLastMessage.content)) {
          secondLastMessage.content.push({
            type: 'text',
            text: bestConnector + newResponse,
          });
        } else {
          this.logger.error('Second last message content is not a list');
          secondLastMessage.content = [
            {
              type: 'text',
              text: toolState.accumulatedOutput,
            },
          ];
        }

        // Remove the user continuation prompt to keep the conversation clean
        if (messages.at(-1)?.role === 'user') {
          messages.pop();
        } else {
          this.logger.error(
            'Last message is not a user message - unexpected format',
          );
        }
      }
    } else {
      this.logger.debug(
        'Last message is a request message rather than a ask to continue after cut off',
      );
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: toolState.accumulatedOutput }],
      });
    }
  }

  /** Determines if generation should continue based on response content. */
  shouldContinue(
    stopReason: string,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    return stopReason === 'length' && !hasEndTag(agentSetting, newResponse);
  }

  /**
   * Processes thinking blocks from API response. OpenAI models do not support thinking blocks.
   * @param responseObject The response object from the OpenAI API
   * @param groupId Optional group ID for logging
   * @param toolState Optional toolState to update with thinking blocks
   * @returns Always returns null as OpenAI doesn't support thinking blocks
   */
  processThinkingBlock(
    responseObject: any,
    groupId?: string,
    toolState?: ToolState,
  ): string | null {
    return null;
  }

  /**
   * Calculates the approximate number of tokens for a given set of messages and system prompt
   * using gpt-tokenizer. This is an estimation and might not perfectly match OpenAI's
   * internal counting, especially for multi-modal content.
   *
   * @param messages The array of message objects.
   * @param systemPrompt Optional system prompt string.
   * @returns The approximate number of tokens.
   * @throws Error if token calculation fails.
   */
  private _calculateApproximateTokens(
    messages: any[],
    systemPrompt?: string,
  ): number {
    // Note: This is a simplified token count. A more accurate count would
    // need to replicate OpenAI's specific chat message formatting rules.
    // https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
    try {
      // Combine system prompt and messages for counting
      // TODO: This might not be perfectly accurate for multi-modal or structured messages.
      // gpt-tokenizer's countTokens might need a ChatMessage structure similar to Anthropic's.
      // For now, concatenate text content.
      let textToCount = systemPrompt ? `${systemPrompt}\n` : '';
      messages.forEach((msg) => {
        if (Array.isArray(msg.content)) {
          msg.content.forEach((part: any) => {
            if (part.type === 'text') {
              textToCount += `${msg.role}: ${part.text}\n`;
            }
            // Basic handling for other types, might need refinement
            else if (part.type === 'image_url') {
              // Approximation: Count tokens for a placeholder text representation
              textToCount += `${msg.role}: [Image]\n`;
            } else if (part.type === 'input_audio') {
              textToCount += `${msg.role}: [Audio]\n`;
            }
          });
        } else if (typeof msg.content === 'string') {
          textToCount += `${msg.role}: ${msg.content}\n`;
        }
      });
      // Use the appropriate encoding based on the model, defaulting to cl100k_base
      // Needs a mapping from model name to encoding or importing specific model tokenizers.
      // Assuming cl100k_base for gpt-3.5/4 for now. Need to enhance this.
      return countTokens(textToCount); // Assuming cl100k_base default
    } catch (err: any) {
      // Log the error and re-throw to indicate failure
      this.logger.error(`Error counting tokens: ${err.message}`);
      throw err;
    }
  }
}
