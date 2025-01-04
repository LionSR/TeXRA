// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - core
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { readFile, fileExists } from '../utils/fileUtils';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSettings, hasEndTag } from './AgentDataclass';
import { AgentStateRound } from './AgentState';
import { ModelHandler } from './ModelHandler';
import { OpenAIAPIResponseUsage, ResponseUsageFactory } from './ResponseUsage';
import { ToolState } from './ToolState';

const K_SLICE = 200;

const CHANNEL = 'Agent';
logger.initializeLogging(CHANNEL);

/**
 * OpenAI-specific handlers.
 */
export class ModelHandlerOpenAI extends ModelHandler {
  /** Get OpenAI client. */
  getClient(): OpenAI {
    const apiKey = this.getApiKey();
    logger.info(CHANNEL, 'Using OpenAI API key.');
    return new OpenAI({ apiKey });
  }

  /** Create a response using OpenAI's API. */
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
      max_tokens: this.config.maxOutputTokens,
      temperature: this.config.name.toLowerCase().includes('o1')
        ? 1.0
        : temperature,
    };

    if (endTag && !this.config.name.toLowerCase().includes('o1')) {
      kwargs.stop = [endTag];
    }

    if (this.config.name.toLowerCase() === 'o1') {
      kwargs.reasoning_effort = 'high';
    }

    return client.chat.completions.create(kwargs);
  }

  /** Initialize messages for OpenAI models. */
  initializeMessages(
    userPrefix: string,
    userRequest: string,
    figureFiles?: string[],
    systemPrompt?: string,
  ): any[] {
    const messages: any[] = [];

    // Handle system prompt differently for O1 models
    if (this.config.name.includes('o1-') || this.config.name === 'o1preview') {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: systemPrompt },
          { type: 'text', text: userPrefix },
        ],
      });
    } else {
      if (systemPrompt) {
        // note that for openai native models, they have been renamed to "developer" but "system" still works
        messages.push({ role: 'system', content: systemPrompt });
      }

      // Create content list with user prefix
      const content: any[] = [{ type: 'text', text: userPrefix }];

      // Add images if provided
      if (figureFiles) {
        content.push(...this.createImageContent(figureFiles));
      }

      // Add user request
      content.push({ type: 'text', text: userRequest });

      messages.push({ role: 'user', content });
    }

    return messages;
  }

  /** Create a reflection message for OpenAI models. */
  createReflectionMessage(
    messages: any[],
    userMessage: string,
    figureFiles?: string[],
  ): any[] {
    const content: any[] = [];

    if (figureFiles) {
      content.push(...this.createImageContent(figureFiles));
    }
    content.push({ type: 'text', text: userMessage });
    messages.push({ role: 'user', content });
    return messages;
  }

  /** Create image content for OpenAI models. */
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

  /** Extract response text and usage statistics from OpenAI response. */
  extractResponse(
    responseObject: any,
    endTag: string,
    autoConfirmation = false,
  ): [string, any, string] {
    if (!responseObject.choices?.length) {
      const errorMsg = 'Invalid response from API: missing choices';
      logger.error(CHANNEL, errorMsg);
      logger.debug(CHANNEL, responseObject);
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

  /** Handle continuation for OpenAI models. */
  addContinueMessage(
    messages: any[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSettings: AgentSettings,
    agentConfig: AgentConfig,
  ): void {
    // Skip if model supports assistant prefill
    if (this.capabilities.supportsAssistantPrefill) {
      logger.debug(
        CHANNEL,
        'Skipping continuation - assistant prefill is supported',
      );
      return;
    }

    // Create continuation message with last K tokens
    const prefillTokens = toolState.lastResponse.slice(-K_SLICE);
    const userMessageContinuation =
      `Your response got cut off, because you only have limited response space. ` +
      `Continue writing exactly from where you left off until the very end, ` +
      `marked by ${agentSettings.endTag}. ` +
      'Avoid repeat yourself and avoid starting over. ' +
      `Start your response at the next token after: "${prefillTokens}"`;

    // Add continuation message
    logger.info(CHANNEL, 'Adding continuation message to conversation');
    logger.debug(CHANNEL, `Continuation message: ${userMessageContinuation}`);
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: userMessageContinuation }],
    });
  }

  /** Initialize output and handle prefill for OpenAI-compatible models. */
  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSettings: AgentSettings,
    messages: any[],
    toolState: ToolState,
    outputFile: string,
    prefill: string,
  ): Promise<[boolean, any[]]> {
    try {
      const fileContent = await readFile(outputFile);

      if (!fileContent || fileContent.length <= 15) {
        if (
          agentConfig.toolConfig.usePrefillFromInput &&
          toolState.firstKCharsFromInput
        ) {
          prefill += toolState.firstKCharsFromInput;
          toolState.updateAccumulatedOutput('');
          prefill = `<${agentSettings.documentTag}>${toolState.firstKCharsFromInput}`;
        }

        messages[messages.length - 1].content.push({
          type: 'text',
          text: `Start your response with\n${prefill}`,
        });
        return [false, messages];
      }

      messages.push({ role: 'assistant', content: fileContent });

      if (hasEndTag(agentSettings, fileContent)) {
        logger.debug(CHANNEL, 'End tag detected - skipping continuation');
        if (Array.isArray(messages[messages.length - 1].content)) {
          messages[messages.length - 1].content[
            messages[messages.length - 1].content.length - 1
          ].text = fileContent;
        } else {
          messages[messages.length - 1].content = fileContent;
        }
        return [true, messages];
      }

      logger.warn(
        CHANNEL,
        'Output file exists but no end tag found - continuing from file',
      );
      toolState.updateAccumulatedOutput(fileContent);
      const state = AgentStateRound.initialize(0);
      toolState.lastResponse = toolState.accumulatedOutput;
      this.addContinueMessage(
        messages,
        state,
        toolState,
        agentSettings,
        agentConfig,
      );

      return [false, messages];
    } catch (error) {
      logger.error(CHANNEL, `Error reading file: ${error}`);
      return [false, messages];
    }
  }

  /** Compute price for OpenAI token usage. */
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

  /** Compute OpenAI-specific statistics. */
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

  /** Update message content for OpenAI models. */
  updateMessageContent(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
    autoConfirmation = false,
  ): void {
    logger.debug(
      CHANNEL,
      'Updating message content for OpenAI API compatible models',
    );

    // for OpenAI models (or models that do not support assistant prefill) the last message is always a user message
    if (messages[messages.length - 1].role === 'user') {
      logger.debug(CHANNEL, 'Last message is a user message');
      if (
        messages[messages.length - 1].content.includes(
          'Your response got cut off',
        )
      ) {
        // the second last message is an assistant message must be a assistant message
        if (messages[messages.length - 2].role === 'assistant') {
          if (Array.isArray(messages[messages.length - 2].content)) {
            messages[messages.length - 2].content.push({
              type: 'text',
              text: bestConnector + newResponse,
            });
          } else {
            logger.error(CHANNEL, 'Second last message content is not a list');
            messages[messages.length - 2].content = toolState.accumulatedOutput;
          }
          // Remove continuation prompt
          messages.pop();
        }
      } else {
        logger.debug(
          CHANNEL,
          'Last message is a request message rather than a ask to continue after cut off',
        );
        // otherwise last message is a request message rather than a ask to continue after cut off
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: toolState.accumulatedOutput }],
        });
      }
    }
  }

  /** Determine if OpenAI model should continue generating. */
  shouldContinue(
    stopReason: string,
    newResponse: string,
    agentSettings: AgentSettings,
  ): boolean {
    logger.info(
      CHANNEL,
      'Determining if should continue for OpenAI model via OpenAI API',
    );
    return stopReason === 'length' && !hasEndTag(agentSettings, newResponse);
  }
}
