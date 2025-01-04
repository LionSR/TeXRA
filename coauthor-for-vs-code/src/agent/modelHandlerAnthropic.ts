// Standard library imports
// (none needed)

// Third-party imports
import Anthropic from '@anthropic-ai/sdk';

// Local imports - core
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { readFile, writeFile, fileExists } from '../utils/fileUtils';
import { filterTagsFromText, extractTextFromTags } from '../utils/xmlUtils';
import {
  applyReplacementRegex,
  getReplacementsByCategory,
} from '../utils/replacementUtils';
import {
  CONFIRMATION_PROMPT_PATTERNS,
  wrapConfirmationPrompts,
} from '../utils/confirmationUtils';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSettings, hasEndTag } from './AgentDataclass';
import { ModelHandler } from './ModelHandler';
import {
  AnthropicAPIResponseUsage,
  ResponseUsageFactory,
} from './ResponseUsage';
import { ToolState } from './ToolState';

const CHANNEL = 'Agent';
logger.initializeLogging(CHANNEL);

/**
 * Anthropic-specific handlers.
 */
export class ModelHandlerAnthropic extends ModelHandler {
  /** Get Anthropic client. */
  getClient(): Anthropic {
    const apiKey = this.getApiKey();
    logger.info(CHANNEL, 'Using Anthropic API key.');
    return new Anthropic({ apiKey });
  }

  /** Create a response using Anthropic's API. */
  async createResponse(
    client: Anthropic,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
  ): Promise<any> {
    return client.beta.messages.create({
      model: this.config.fullName,
      max_tokens: this.config.maxOutputTokens,
      messages,
      temperature,
      stop_sequences: endTag ? [endTag] : undefined,
      system: systemPrompt,
    });
  }

  /** Initialize messages for Anthropic models. */
  initializeMessages(
    userPrefix: string,
    userRequest: string,
    figureFiles?: string[],
    systemPrompt?: string,
  ): any[] {
    // Create content list with user prefix
    const content: any[] = [{ type: 'text', text: userPrefix }];

    // Add images if provided
    if (figureFiles) {
      content.push(...this.createImageContent(figureFiles));
    }

    // Add user request with optional caching
    const request = {
      type: 'text',
      text: userRequest,
      ...(this.capabilities.supportsPromptCaching
        ? { cache_control: { type: 'ephemeral' } }
        : {}),
    };
    content.push(request);

    // Note: Anthropic handles system prompts differently via createResponse()
    return [{ role: 'user', content }];
  }

  /** Create a reflection message for Anthropic models. */
  createReflectionMessage(
    messages: any[],
    userMessage: string,
    figureFiles?: string[],
  ): any[] {
    // Create content list
    const content: any[] = [];

    // Add images if provided
    if (figureFiles) {
      content.push(...this.createImageContent(figureFiles));
    }

    // Add message with optional caching
    const message = {
      type: 'text',
      text: userMessage,
      ...(this.capabilities.supportsPromptCaching
        ? { cache_control: { type: 'ephemeral' } }
        : {}),
    };
    content.push(message);

    // Manage cache control for previous messages
    if (
      this.capabilities.supportsPromptCaching &&
      Array.isArray(messages[messages.length - 1].content)
    ) {
      const prevContent = messages[messages.length - 1].content;
      if (prevContent.length >= 2) {
        delete prevContent[prevContent.length - 2].cache_control;
      } else if (prevContent.length === 1) {
        delete messages[0].content[messages[0].content.length - 1]
          .cache_control;
      }
    }

    messages.push({ role: 'user', content });
    return messages;
  }

  /** Create image content for Anthropic models. */
  createImageContent(imageContents: any[]): any[] {
    return imageContents.flatMap((image) => {
      const isPdf =
        this.capabilities.supportsNativePdf &&
        image.media_type === 'application/pdf';
      return [
        {
          type: 'text',
          text: `${isPdf ? 'Document' : 'Image'}: ${image.file_name}`,
        },
        {
          type: isPdf ? 'document' : 'image',
          source: {
            type: 'base64',
            media_type: image.media_type,
            data: image.data,
          },
        },
      ];
    });
  }

  /** Extract response text and usage statistics from Anthropic response. */
  extractResponse(
    responseObject: any,
    endTag: string,
    autoConfirmation = false,
  ): [string, any, string] {
    if (responseObject.error) {
      const errorMsg = `API error: ${responseObject.error}`;
      logger.error(CHANNEL, errorMsg);
      throw new Error(errorMsg);
    }

    // Check for empty response
    if (responseObject.usage.output_tokens === 3) {
      // Anthropic specific empty response check
      const errorMsg = 'No output generated - API returned empty response';
      logger.error(CHANNEL, errorMsg);
      logger.debug(CHANNEL, `responseObject: ${responseObject}`);
      logger.debug(
        CHANNEL,
        `responseObject.content: ${responseObject.content}`,
      );
      throw new Error(errorMsg);
    }

    // Extract base response
    let stopReason = responseObject.stop_reason;
    let newResponse = responseObject.content[0].text.trim();

    // Handle auto confirmation
    if (this.capabilities.likesToAskForConfirmation && autoConfirmation) {
      newResponse = wrapConfirmationPrompts(newResponse);
    }

    // Check for confirmation patterns
    if (
      CONFIRMATION_PROMPT_PATTERNS.some((pattern) =>
        newResponse.toLowerCase().includes(pattern.toLowerCase()),
      )
    ) {
      stopReason = 'ask_for_confirmation';
    }

    // Handle output tags if present
    if (
      newResponse.includes('<output>') &&
      this.capabilities.likesToAskForConfirmation &&
      autoConfirmation
    ) {
      logger.warn(
        CHANNEL,
        'Output tag detected - extracting latex code from <output> tags',
      );
      const extractedResponse = extractTextFromTags(newResponse, 'output');
      if (extractedResponse !== newResponse) {
        logger.warn(CHANNEL, 'Extracted content from <output> tags');
        newResponse = extractedResponse;
      } else {
        logger.warn(CHANNEL, 'No <output> tags found in response');
      }
    }

    // Apply formatting
    newResponse = applyReplacementRegex(
      newResponse,
      getReplacementsByCategory('autoConfirmation'),
      'gms',
    );

    if (autoConfirmation) {
      newResponse = filterTagsFromText(newResponse, 'monologue');
    }

    // Add end tag if needed
    if (stopReason === 'stop_sequence' && !newResponse.includes(endTag)) {
      newResponse += `\n${endTag}`;
    }

    return [newResponse, responseObject.usage, stopReason];
  }

  /** Handle continuation for Anthropic models. */
  addContinueMessage(
    messages: any[],
    stateRound: any,
    toolState: ToolState,
    agentSettings: AgentSettings,
    agentConfig: AgentConfig,
  ): void {
    // Skip if model doesn't need confirmation
    if (
      !this.capabilities.likesToAskForConfirmation ||
      !agentConfig.toolConfig.autoConfirmation
    ) {
      return;
    }

    // Create continuation message based on round count
    const outputTokens = stateRound.APIUsage?.output_tokens ?? 0;

    const userMessageContinuation =
      stateRound.continuationCount <= 1
        ? 'Proceed. ' +
          'If no previous revised output of the document is provided, ' +
          'please start from the very beginning of the document and work through the full document systematically. ' +
          'Note that you have an effectively infinite token response limit ' +
          'because the system that you are part of handles continuations automatically. Therefore, just output the complete document. ' +
          `The total number of tokens you output in the last turn is ${outputTokens}, ` +
          'but the maximal token limit is 8192. Therefore, you are encouraged to maximize the output length in the next turn. ' +
          'Respond the latex code of the next section in the <output> ... </output> tags.'
        : 'Proceed to write fully the next part/section (not just a subsection, which is not enough). ' +
          'Continue writing exactly from where you left off until the whole document has been systematically revised. ' +
          'Aim for double the length of output as previous turns. ' +
          'Remember to stay professional and write latex code all the time. ' +
          'Note that you have an effectively infinite token response limit ' +
          'because the system that you are part of handles continuations automatically. Therefore, just output the complete document. ' +
          `The total number of tokens you output in the last turn is ${outputTokens}, ` +
          'but the maximal token limit is 8192. Therefore, you are encouraged to maximize the output length in the next turn. ' +
          'Respond the latex code of the next section in the <output> ... </output> tags.';

    // Handle document tag if present
    const documentTagStart = `<${agentSettings.documentTag}>`;
    const firstLines = toolState.lastResponse.split('\n').slice(0, 10);
    for (const line of firstLines) {
      if (line.trim().startsWith(documentTagStart)) {
        logger.warn(
          CHANNEL,
          `Removing document tag prefix ${documentTagStart} from response`,
        );
        toolState.lastResponse = toolState.lastResponse
          .replace(line, '')
          .trim();
        break;
      }
    }

    // Filter monologue tags
    toolState.lastResponse = filterTagsFromText(
      toolState.lastResponse,
      'monologue',
    );

    // Update messages
    logger.info(CHANNEL, 'Adding User message');
    logger.debug(CHANNEL, userMessageContinuation);

    if (messages[messages.length - 1].role === 'user') {
      if (messages[messages.length - 2]?.role === 'assistant') {
        logger.warn(
          CHANNEL,
          'Appending new response to the previous assistant message',
        );
        if (Array.isArray(messages[messages.length - 2].content)) {
          messages[messages.length - 2].content.push({
            type: 'text',
            text: '\n' + toolState.lastResponse.trim(),
          });
        } else if (typeof messages[messages.length - 2].content === 'string') {
          messages[messages.length - 2].content +=
            '\n' + toolState.lastResponse.trim();
        }
      }
      messages[messages.length - 1].content = userMessageContinuation.trim();
    } else if (messages[messages.length - 1].role === 'assistant') {
      messages.push({
        role: 'user',
        content: userMessageContinuation.trim(),
      });
    }
  }

  /** Initialize output and handle prefill for Anthropic models. */
  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSettings: AgentSettings,
    messages: any[],
    toolState: ToolState,
    outputFile: string,
    prefill: string,
  ): Promise<[boolean, any[]]> {
    // Check if file doesn't exist or is too small
    if (
      !(await fileExists(outputFile)) ||
      (await readFile(outputFile)).length <= 15
    ) {
      if (
        agentConfig.toolConfig.usePrefillFromInput &&
        toolState.firstKCharsFromInput
      ) {
        prefill += toolState.firstKCharsFromInput;
        toolState.updateAccumulatedOutput(toolState.firstKCharsFromInput);
      }

      logger.debug(CHANNEL, `Anthropic prefill: ${prefill}`);

      if (
        toolState.accumulatedOutput === '<scratchpad>' &&
        prefill === '<scratchpad>'
      ) {
        await writeFile(outputFile, prefill);
      } else if (agentSettings.outputExt === 'xml') {
        await writeFile(outputFile, prefill + '\n');
      }

      messages.push({ role: 'assistant', content: prefill });
      return [false, messages];
    }

    // Get prefill from existing and non-trivial file
    let fileContent = await readFile(outputFile);

    if (
      this.capabilities.likesToAskForConfirmation &&
      agentConfig.toolConfig.autoConfirmation
    ) {
      fileContent = filterTagsFromText(fileContent, 'monologue');
      fileContent = applyReplacementRegex(
        fileContent,
        getReplacementsByCategory('autoConfirmation'),
        'gms',
      );
    }
    fileContent = fileContent.trim();

    if (hasEndTag(agentSettings, fileContent)) {
      logger.debug(CHANNEL, 'End tag detected - skipping continuation');
      if (Array.isArray(messages[messages.length - 1].content)) {
        messages[messages.length - 1].content[
          messages[messages.length - 1].content.length - 1
        ].text = fileContent;
      } else {
        messages[messages.length - 1].content = fileContent;
      }

      if (
        messages[messages.length - 1].content[
          messages[messages.length - 1].content.length - 1
        ]?.cache_control
      ) {
        delete messages[messages.length - 1].content[
          messages[messages.length - 1].content.length - 1
        ].cache_control;
      }
      return [true, messages];
    }

    logger.warn(
      CHANNEL,
      'Output file exists but no end tag found - continuing from file',
    );
    toolState.updateAccumulatedOutput(fileContent);
    const content = this.capabilities.supportsPromptCaching
      ? [
          {
            type: 'text',
            text: fileContent,
            cache_control: { type: 'ephemeral' },
          },
        ]
      : fileContent;
    logger.debug(CHANNEL, `Using existing content as prefill: ${outputFile}`);

    messages.push({ role: 'assistant', content });
    return [false, messages];
  }

  /** Compute the price for token usage. */
  computePrice(responseUsage: any): number {
    let basePrice =
      (responseUsage.input_tokens * this.config.inputPrice +
        responseUsage.output_tokens * this.config.outputPrice) /
      1e6;

    if (this.capabilities.supportsPromptCaching) {
      if ('cache_creation_input_tokens' in responseUsage) {
        basePrice +=
          (responseUsage.cache_creation_input_tokens *
            this.config.inputPrice *
            1.25) /
          1e6;
      }
      if ('cache_read_input_tokens' in responseUsage) {
        basePrice +=
          (responseUsage.cache_read_input_tokens *
            this.config.inputPrice *
            0.1) /
          1e6;
      }
    }

    return basePrice;
  }

  /** Compute model-specific response usage from response usage object. */
  computeResponseUsage(
    responseUsage: any,
    responseTime: number,
  ): AnthropicAPIResponseUsage {
    return ResponseUsageFactory.fromAnthropicResponse(
      responseUsage,
      this.computePrice(responseUsage),
      responseTime,
    );
  }

  /** Update message content for Anthropic models. */
  updateMessageContent(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
    autoConfirmation = false,
  ): void {
    logger.debug(CHANNEL, 'Updating message content for Anthropic models');
    if (messages[messages.length - 1].role === 'assistant') {
      const lastMessage = messages[messages.length - 1];

      if (Array.isArray(lastMessage.content)) {
        const newMessage = { type: 'text', text: bestConnector + newResponse };
        lastMessage.content.push(newMessage);
      } else {
        lastMessage.content = toolState.accumulatedOutput;
      }

      if (this.capabilities.supportsPromptCaching) {
        if (Array.isArray(lastMessage.content)) {
          // Add cache_control to new message
          lastMessage.content[lastMessage.content.length - 1].cache_control = {
            type: 'ephemeral',
          };
          // Remove cache control from previous message if it exists
          if (
            lastMessage.content.length >= 2 &&
            typeof lastMessage.content[lastMessage.content.length - 2] ===
              'object'
          ) {
            delete lastMessage.content[lastMessage.content.length - 2]
              .cache_control;
          }
        } else {
          // Initialize content list with single message
          lastMessage.content = [
            {
              type: 'text',
              text: toolState.accumulatedOutput,
              cache_control: { type: 'ephemeral' },
            },
          ];
        }
      }
    }
  }

  /** Determine if Anthropic model should continue generating. */
  shouldContinue(
    stopReason: string,
    newResponse: string,
    agentSettings: AgentSettings,
  ): boolean {
    logger.info(
      CHANNEL,
      'Determining if should continue for Anthropic model via Anthropic API',
    );
    return (
      stopReason !== 'max_tokens' &&
      stopReason !== 'stop_sequence' &&
      !hasEndTag(agentSettings, newResponse)
    );
  }
}
