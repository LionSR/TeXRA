// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - utilities
import { readFile, fileExists, writeFile } from '../utils/workspaceFileUtils';
import {
  applyReplacements,
  getReplacementsByCategory,
  getAllReplacements,
  getAllReplacementsRegex,
} from '../utils/replacementUtils';

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
      kwargs.reasoning_effort = this.config.capabilities.reasoning_effort;
    }

    try {
      const response = await client.chat.completions.create(kwargs);
      return response;
    } catch (err) {
      this.logger.error(`Error in createResponse: ${err}`);
      throw err;
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
        messages.push({ role: 'system', content: systemPrompt });
      } else {
        // e.g., O1 mini and O1 preview models do not support system prompt
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: systemPrompt },
          ],
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
  createReflectionMessages(
    messages: any[],
    userMessage: string,
    figureFiles?: string[],
  ): any[] {
    const content: any[] = [];

    if (figureFiles) {
      content.push(...this.createImageContent(figureFiles));
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
  extractResponse(responseObject: any, endTag: string): [string, any, string] {
    if (!responseObject.choices?.length) {
      this.logger.debug(`Response object: ${JSON.stringify(responseObject)}`);
      if (responseObject.error) {
        const errorMsg = `API error: ${responseObject.error}`;
        this.logger.error(errorMsg);
        throw new Error(errorMsg);
      }
      const errorMsg = 'Invalid response from API: missing choices';
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    // Extract base response
    const choice = responseObject.choices[0];
    const stopReason = choice.finish_reason;
    let newResponse = choice.message.content.trim();

    // Add end tag if response was stopped and tag isn't present
    if (stopReason === 'stop' && endTag && !newResponse.includes(endTag)) {
      newResponse = `${newResponse}\n${endTag}`;
    }

    return [newResponse, responseObject.usage, stopReason];
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

    if (
      !(await fileExists(outputFile)) ||
      (await readFile(outputFile)).length <= 15
    ) {
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

    let fileContent = await readFile(outputFile);
    fileContent = applyReplacements(fileContent, getAllReplacements()).trim();
    fileContent = applyReplacements(
      fileContent,
      getAllReplacementsRegex(),
    ).trim();
    await writeFile(outputFile, fileContent);

    messages.push({ role: 'assistant', content: fileContent });

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.info('End tag detected - skipping continuation');
      if (Array.isArray(messages.at(-1).content)) {
        messages.at(-1).content[messages.at(-1).content.length - 1].text =
          fileContent;
      } else {
        messages.at(-1).content = fileContent;
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
      if (messages.at(-1)?.content.includes('Your response got cut off')) {
        // the second last message is an assistant message must be a assistant message
        if (messages.at(-2).role === 'assistant') {
          if (Array.isArray(messages.at(-2)?.content)) {
            messages.at(-2).content.push({
              type: 'text',
              text: bestConnector + newResponse,
            });
          } else {
            this.logger.error('Second last message content is not a list');
            messages.at(-2).content = toolState.accumulatedOutput;
          }
          // Remove continuation prompt
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
