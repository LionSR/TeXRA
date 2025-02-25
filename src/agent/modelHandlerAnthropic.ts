// Standard library imports
// (none needed)

// Third-party imports
import Anthropic from '@anthropic-ai/sdk';

// Local imports - utilities
import { readFile, writeFile, fileExists } from '../utils/workspaceFileUtils';
import { filterTagsFromText, extractTextFromTag } from '../utils/xmlUtils';
import {
  applyReplacements,
  getReplacementsByCategory,
  getAllReplacements,
  getAllReplacementsRegex,
} from '../utils/replacementUtils';
import {
  CONFIRMATION_PROMPT_PATTERNS,
  wrapConfirmationPrompts,
} from '../utils/confirmationUtils';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSetting, hasEndTag } from './AgentDataclass';
import { ModelHandler } from './ModelHandler';
import {
  AnthropicAPIResponseUsage,
  ResponseUsageFactory,
} from './ResponseUsage';
import { ToolState } from './ToolState';

/**
 * Anthropic-specific model handler implementation for managing API interactions and message processing.
 */

// The new implicit prompt caching is worth checking out (can eliminate many controls of previous caching)
export class ModelHandlerAnthropic extends ModelHandler {
  /** Initializes an Anthropic API client using the configured API key. */
  async getClient(): Promise<Anthropic> {
    const apiKey = await this.getApiKey();
    this.logger.debug('Using Anthropic API.');
    return new Anthropic({ apiKey });
  }

  /** Creates a chat completion response using Anthropic's API with specified parameters and optional system prompt. */
  async createResponse(
    client: Anthropic,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
  ): Promise<any> {
    // Prepare options for the API call
    const options: any = {
      model: this.config.fullName,
      max_tokens: this.config.maxOutputTokens,
      messages,
      temperature,
      stop_sequences: endTag ? [endTag] : undefined,
      system: systemPrompt,
    };

    // Add beta features for Claude 3.7 Sonnet to increase max output to 128k tokens and enable thinking
    if (this.config.fullName === 'claude-3-7-sonnet-20250219') {
      options.betas = ['output-128k-2025-02-19'];
      // Update max tokens to use the higher limit
      options.max_tokens = this.config.maxOutputTokens;
      options.thinking = {
        type: 'enabled',
        budget_tokens: 32000,
      };
    }

    return client.beta.messages.create(options);
  }

  /** Initializes the message array for Anthropic chat models with user prefix, request, and optional images. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    figureFiles?: string[],
    systemPrompt?: string,
  ): Promise<any[]> {
    // Create content list with user prefix
    const content: any[] = [{ type: 'text', text: userPrefix }];

    // Add images if provided
    if (figureFiles) {
      content.push(...(await this.createImageMessage(figureFiles)));
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

  /** Creates a reflection message array for Anthropic models, managing cache control and image content. */
  createReflectionMessages(
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

    // Since Anthropic now automatically checks for cache hits at previous positions,
    // we only need to remove cache_control from previous message to avoid
    // exceeding the 4 cache breakpoint limit
    if (
      this.capabilities.supportsPromptCaching &&
      Array.isArray(messages.at(-1)?.content)
    ) {
      const prevContent = messages.at(-1).content;
      for (let i = 0; i < prevContent.length; i++) {
        if (prevContent[i]?.cache_control) {
          delete prevContent[i].cache_control;
        }
      }
    }

    messages.push({ role: 'user', content });
    return messages;
  }

  /** Converts image/document content array into Anthropic-compatible message format with type and source metadata. */
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

  /** Processes Anthropic API response, handling errors, confirmations, and formatting while returning [response, usage, stopReason]. */
  extractResponse(
    responseObject: any,
    endTag: string,
    autoConfirmation = false,
  ): [string, any, string] {
    if (responseObject.error) {
      const errorMsg = `API error: ${responseObject.error}`;
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    // Check for empty response
    if (responseObject.usage.output_tokens === 3) {
      // Anthropic specific empty response check
      const errorMsg = 'No output generated - API returned empty response';
      this.logger.error(errorMsg);
      this.logger.debug(`responseObject: ${responseObject}`);
      this.logger.debug(`responseObject.content: ${responseObject.content}`);
      throw new Error(errorMsg);
    }

    // Extract base response
    let stopReason = responseObject.stop_reason;
    let newResponse = '';

    // Check if we're using Claude 3.7 Sonnet with thinking enabled
    const isThinkingEnabled =
      this.config.fullName === 'claude-3-7-sonnet-20250219' &&
      this.capabilities.supportsReasoning;

    if (isThinkingEnabled && Array.isArray(responseObject.content)) {
      // Handle thinking blocks in Claude 3.7 Sonnet responses
      for (const block of responseObject.content) {
        if (block.type === 'text') {
          newResponse += block.text.trim();
        }
        // We don't include thinking blocks (type: thinking or redacted_thinking) in the response text
        // They need to be preserved in the message object for the next turn though
      }
    } else if (responseObject.content && responseObject.content.length > 0) {
      // Handle regular text responses
      newResponse = responseObject.content[0].text.trim();
    }

    if (this.capabilities.likesToAskForConfirmation && autoConfirmation) {
      newResponse = wrapConfirmationPrompts(newResponse);

      // Check for confirmation patterns
      if (
        CONFIRMATION_PROMPT_PATTERNS.some((pattern) =>
          newResponse.toLowerCase().includes(pattern.toLowerCase()),
        )
      ) {
        stopReason = 'ask_for_confirmation';
      }

      // Apply formatting
      newResponse = applyReplacements(
        newResponse,
        getReplacementsByCategory('autoConfirmation')!,
      );
      newResponse = filterTagsFromText(newResponse, 'monologue');

      // Handle output tags if present
      if (newResponse.includes('<output>')) {
        this.logger.warn(
          'Output tag detected - extracting latex code from <output> tags',
        );
        const extractedResponse = extractTextFromTag(newResponse, 'output');
        if (extractedResponse !== newResponse) {
          this.logger.warn('Extracted content from <output> tags');
          newResponse = extractedResponse;
        } else {
          this.logger.warn('No <output> tags found in response');
        }
      }
    }

    // Add end tag if needed
    if (stopReason === 'stop_sequence' && !newResponse.includes(endTag)) {
      newResponse += `\n${endTag}`;
    }

    return [newResponse, responseObject.usage, stopReason];
  }

  /** Adds continuation message for handling multi-turn conversations, managing token limits and output formatting. */
  addContinueMessage(
    messages: any[],
    stateRound: any,
    toolState: ToolState,
    agentSetting: AgentSetting,
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
    const documentTagStart = `<${agentSetting.documentTag}>`;
    const firstLines = toolState.lastResponse.split('\n').slice(0, 10);
    for (const line of firstLines) {
      if (line.trim().startsWith(documentTagStart)) {
        this.logger.warn(
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
    this.logger.info('Adding User message');
    this.logger.debug(userMessageContinuation);

    if (messages.at(-1).role === 'user') {
      if (messages.at(-2).role === 'assistant') {
        this.logger.warn(
          'Appending new response to the previous assistant message',
        );
        if (Array.isArray(messages.at(-2).content)) {
          messages.at(-2).content.push({
            type: 'text',
            text: '\n' + toolState.lastResponse.trim(),
          });
        } else if (typeof messages.at(-2).content === 'string') {
          messages.at(-2).content += '\n' + toolState.lastResponse.trim();
        }
      }
      messages.at(-1).content = userMessageContinuation.trim();
    } else if (messages.at(-1).role === 'assistant') {
      messages.push({
        role: 'user',
        content: userMessageContinuation.trim(),
      });
    }
  }

  /** Initializes output file and handles prefill content, returning [isComplete, updatedMessages]. */
  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: any[],
    toolState: ToolState,
    outputFile: string,
    prefill: string,
  ): Promise<[boolean, any[]]> {
    // Check if we're using Claude 3.7 Sonnet with thinking enabled
    const isThinkingEnabled = this.capabilities.supportsReasoning;

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
        toolState.updateAccumulatedOutput(toolState.firstKCharsFromInput);
      }

      this.logger.debug(`Adding prefill message:\n${prefill}`);

      if (
        toolState.accumulatedOutput.includes('<scratchpad>') &&
        prefill === '<scratchpad>' // this is not so neat
      ) {
        await writeFile(outputFile, prefill);
      } else if (agentSetting.outputExt === 'xml') {
        await writeFile(outputFile, prefill + '\n');
      }

      messages.push({ role: 'assistant', content: prefill });
      return [endTurn, messages];
    }

    // Get prefill from existing and non-trivial file
    let fileContent = await readFile(outputFile);
    fileContent = applyReplacements(fileContent, getAllReplacements()).trim();
    fileContent = applyReplacements(
      fileContent,
      getAllReplacementsRegex(),
    ).trim();
    await writeFile(outputFile, fileContent);

    if (
      this.capabilities.likesToAskForConfirmation &&
      agentConfig.toolConfig.autoConfirmation
    ) {
      fileContent = filterTagsFromText(fileContent, 'monologue');
      fileContent = applyReplacements(
        fileContent,
        getReplacementsByCategory('autoConfirmation')!,
      );
    }
    fileContent = fileContent.trim();

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug('End tag detected - skipping continuation');
      if (Array.isArray(messages.at(-1).content)) {
        messages.at(-1).content[messages.at(-1).content.length - 1].text =
          fileContent;
      } else {
        messages.at(-1).content = fileContent;
      }

      // With the updated Anthropic prompt caching, we don't need to manually maintain cache controls
      // Remove any existing cache_control to avoid reaching the 4 breakpoint limit
      if (
        Array.isArray(messages.at(-1).content) &&
        messages.at(-1).content.length > 0
      ) {
        for (let i = 0; i < messages.at(-1).content.length; i++) {
          if (
            typeof messages.at(-1).content[i] === 'object' &&
            messages.at(-1).content[i]?.cache_control
          ) {
            delete messages.at(-1).content[i].cache_control;
          }
        }
      }

      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.warn(
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
    this.logger.debug(`Using existing content as prefill: ${outputFile}`);

    messages.push({ role: 'assistant', content });
    endTurn = false;
    return [endTurn, messages];
  }

  /** Calculates API usage cost based on input/output tokens and cache usage if supported. */
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

  /** Computes detailed response usage metrics including tokens, price, and response time. */
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

  /** Updates message content with new responses while managing cache control and content formatting. */
  updateMessageContent(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
    autoConfirmation = false,
  ): void {
    if (messages.at(-1).role === 'assistant') {
      const lastMessage = messages.at(-1);

      if (Array.isArray(lastMessage.content)) {
        const newMessage = { type: 'text', text: bestConnector + newResponse };
        lastMessage.content.push(newMessage);
      } else {
        lastMessage.content = toolState.accumulatedOutput;
      }

      if (this.capabilities.supportsPromptCaching) {
        if (Array.isArray(lastMessage.content)) {
          // With the updated Anthropic prompt caching, we only need to add cache_control
          // to the new message - Anthropic will automatically check for cache hits
          // at previous positions

          // First clear any existing cache control points to stay under the 4 breakpoint limit
          for (let i = 0; i < lastMessage.content.length - 1; i++) {
            if (
              typeof lastMessage.content[i] === 'object' &&
              lastMessage.content[i]?.cache_control
            ) {
              delete lastMessage.content[i].cache_control;
            }
          }

          // Add cache_control to the new message
          lastMessage.content.at(-1).cache_control = {
            type: 'ephemeral',
          };
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

  /** Determines if generation should continue based on stop reason and end tag presence. */
  shouldContinue(
    stopReason: string,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    // this.logger.debug(
    //   'Determining if should continue for Anthropic model via Anthropic API',
    // );
    return (
      stopReason !== 'max_tokens' &&
      stopReason !== 'stop_sequence' &&
      !hasEndTag(agentSetting, newResponse)
    );
  }
}
