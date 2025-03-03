// Standard library imports
// (none needed)

// Third-party imports
import OpenAI, {
  RateLimitError,
  NotFoundError,
  PermissionDeniedError,
} from 'openai';

// Local imports - utilities
import {
  readFile,
  fileExists,
  writeFile,
  fileExistsAndNonTrivial,
} from '../utils/workspaceFileUtils';
import {
  applyReplacements,
  getAllReplacements,
  getAllReplacementsRegex,
} from '../utils/replacementUtils';
import { getConfig } from '../frontend-utils/commonUtils';
import { extractAndLogThinking } from '../utils/xmlUtils';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSetting, hasEndTag } from './AgentDataclass';
import { AgentStateRound } from './AgentState';
import { ModelHandler } from './ModelHandler';
import { OpenAIAPIResponseUsage, ResponseUsageFactory } from './ResponseUsage';
import { ToolState } from './ToolState';

const K_SLICE = 200;

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
  ): Promise<any> {
    // Get streaming config
    const useStreaming = getConfig<boolean>('model.useStreaming', false);

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

    // Handle O1 models
    if (this.isOReasoningModelFull) {
      kwargs.reasoning_effort = this.config.capabilities.reasoningEffort;
    }

    if (useStreaming) {
      let response: any;
      try {
        const stream = client.beta.chat.completions.stream(kwargs);
        response = await stream.finalMessage();

        // in the future if we pass stream to outside, calling stream.controller.abort() will abort the stream; which will be very useful for our stop button
        // we should also make sure partial results can be returned in the presence of errors!
      } catch (err) {
        if (
          err instanceof NotFoundError ||
          err instanceof RateLimitError ||
          PermissionDeniedError
        ) {
          throw err;
        }
        this.logger.error(`Error in createResponse(streaming): ${err}`);
      }
      return response;
    } else {
      try {
        const response = await client.chat.completions.create(kwargs);
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
    figureFiles?: string[],
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

    // Create content list with user prefix
    const content: any[] = [{ type: 'text', text: userPrefix }];

    // Add images if provided
    if (figureFiles && this.config.capabilities.supportsVision) {
      content.push(...(await this.createImageMessage(figureFiles)));
    }

    const lastRole = messages.at(-1).role;
    if (messages.length > 0) {
      if (lastRole === 'system') {
        messages.push({ role: 'user', content });
      } else if (lastRole === 'user') {
        messages.at(-1).content.push(...content);
      }
    } else {
      messages.push({ role: 'user', content });
    }

    // Add user request
    const role = this.config.capabilities.supportsIntermDevMsgs
      ? 'system'
      : 'user';
    messages.push({
      role,
      content: [{ type: 'text', text: userRequest }],
    });

    return messages;
  }

  /** Adds user message with reflection content to existing messages. */
  async createReflectionMessages(
    messages: any[],
    userMessage: string,
    figureFiles?: string[],
  ): Promise<any[]> {
    const content: any[] = [];

    if (figureFiles && figureFiles.length > 0) {
      try {
        const imageContent = await this.createImageMessage(figureFiles);
        content.push(...imageContent);
      } catch (err) {
        this.logger.error(`Error processing image files: ${err}`);
      }
    }
    content.push({ type: 'text', text: userMessage });
    const role = this.config.capabilities.supportsIntermDevMsgs
      ? 'system'
      : 'user';
    messages.push({ role, content });
    return messages;
  }

  /** Formats image content for OpenAI's vision API. */
  createImageContent(imageContents: any[]): any[] {
    return imageContents.flatMap((image) => [
      { type: 'text', text: `Image: ${image.file_name}` },
      {
        type: 'image_url',
        image_url: {
          url: `data:${image.media_type};base64,${image.data}`,
          media_type: image.media_type,
          data: image.data,
        },
      },
    ]);
  }

  /** Extracts response text and usage statistics from API response. */
  extractResponse(
    responseObject: any,
    endTag: string,
  ): [string, any, any, string] {
    if (!responseObject.choices?.length) {
      this.logger.debug(`Response object: ${JSON.stringify(responseObject)}`);
      if (responseObject.error) {
        const errorMsg = `API error: ${responseObject.error}`;
        this.logger.error(errorMsg);
        throw new Error(errorMsg);
      }
      const errorMsg = 'Invalid response from API: missing choices';
      this.logger.error(errorMsg);
      this.logger.error(`Response object: ${JSON.stringify(responseObject)}`);
      throw new Error(errorMsg);
    }

    // Extract base response
    const choice = responseObject.choices[0];
    const stopReason = choice.finish_reason;
    let newResponse = '';
    if (choice.message.content) {
      newResponse = choice.message.content.trim();
    } else {
      newResponse = '';
      this.logger.error(`Response object: ${JSON.stringify(responseObject)}`);
      this.logger.error('content is empty');
    }

    // OpenAI doesn't have thinking blocks like Anthropic, so we return null
    // However deepseek/openrouter models might have thinking blocks
    let thinkingBlock = null;
    if (choice.message.reasoning_content) {
      thinkingBlock = {
        type: 'thinking',
        thinking: choice.message.reasoning_content,
      };
    }

    // Add end tag if response was stopped and tag isn't present
    if (stopReason === 'stop' && endTag && !newResponse.includes(endTag)) {
      newResponse = `${newResponse}\n${endTag}`;
    }

    return [newResponse, responseObject.usage, thinkingBlock, stopReason];
  }

  /** Adds continuation message when response is truncated. */
  addContinueMessage(
    messages: any[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void {
    // Skip if model supports assistant prefill
    if (this.capabilities.supportsAssistantPrefill) {
      this.logger.debug(
        'Skipping continuation - assistant prefill is supported',
      );
      return;
    }

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
    fileContent = applyReplacements(fileContent, getAllReplacements()).trim();
    fileContent = applyReplacements(
      fileContent,
      getAllReplacementsRegex(),
    ).trim();

    // Extract and log any existing scratchpad content
    extractAndLogThinking(fileContent, this.logger);

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
    const state = AgentStateRound.initialize(0);
    toolState.lastResponse = toolState.accumulatedOutput;
    this.addContinueMessage(
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
  computePrice(responseUsage: any): number {
    // Handle Google models that return None for usage
    if (!responseUsage) {
      return 0.0;
    }

    // Get token counts with defaults for Google models
    const promptTokens = responseUsage.prompt_tokens ?? 0;
    const completionTokens = responseUsage.completion_tokens ?? 0;

    let basePrice =
      (promptTokens * this.config.inputPrice +
        completionTokens * this.config.outputPrice) /
      1e6;

    // Handle special token types
    if (responseUsage.reasoning_tokens) {
      basePrice +=
        (responseUsage.reasoning_tokens * this.config.outputPrice) / 1e6;
    }
    if (responseUsage.cached_tokens) {
      basePrice -=
        (responseUsage.cached_tokens * this.config.inputPrice * 0.5) / 1e6;
    }

    return basePrice;
  }

  /** Creates usage statistics from OpenAI's response format. */
  computeResponseUsage(
    responseUsage: any,
    responseTime: number,
  ): OpenAIAPIResponseUsage {
    // For Google models, create a minimal usage object with zeros
    if (!responseUsage) {
      const emptyUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: {
          reasoning_tokens: 0,
          accepted_prediction_tokens: null,
          rejected_prediction_tokens: null,
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

  /** Updates message content with new response or continuation. */
  updateMessageContent(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void {
    this.logger.debug(
      'Updating message content for OpenAI API compatible models',
    );

    // for OpenAI models (or models that do not support assistant prefill) the last message is always a user/system message
    if (
      messages.at(-1)?.role === 'user' ||
      messages.at(-1)?.role === 'system'
    ) {
      this.logger.debug('Last message is a user message');
      const lastMessage = messages.at(-1);
      const secondLastMessage = messages.at(-2);
      if (this.containCutOffMessage(lastMessage.content)) {
        // Then the last message is a user message
        // SO the second last message must be an assistant message
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
          // Remove user continuation prompt
          messages.pop();
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
  }

  /** Determines if generation should continue based on response content. */
  shouldContinue(
    stopReason: string,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    return stopReason === 'length' && !hasEndTag(agentSetting, newResponse);
  }
}
