// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, hasEndTag } from '@agent/core/AgentDataclass';
import { ConversationRoundState } from '@agent/core/AgentState';
import {
  OpenAIAPIResponseUsage,
  ResponseUsageFactory,
} from '@agent/core/ResponseUsage';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { createContinuationMessage } from '@agent/utils/continuationMessage';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Type imports
import type { ModelConfig } from '@model';

// Internal imports
import { cleanFileContent } from '@replacement/engine';
import { K_SLICE, MESSAGE_PREVIEW_LENGTH } from '@utils/config';
import { WorkspaceFS, flexibleFS } from '@utils/files';
import xmlUtils from '@utils/text/xmlUtils';

// Local file imports
import { ModelHandler } from './ModelHandler';
import { OPENAI_CHAT_FINISH } from './types/StopReasonTypes';
import type { ProviderStopReason } from './types/StopReasonTypes';

/**
 * Message format for VS Code Language Model API
 * Supports text content and simple structure
 */
interface VSCodeLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Simulated response object to maintain compatibility with base class
 */
interface VSCodeLMResponse {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Model selector configuration for VS Code Language Model API
 * Supports flexible model selection by vendor, family, id, or version
 */
interface VSCodeLMSelector {
  vendor?: string;
  family?: string;
  id?: string;
  version?: string;
}

/**
 * Handler for VS Code Language Model API.
 * Provides seamless integration with all models available through VS Code's
 * native Language Model API, including VS Code LM, Claude, O1, and others.
 *
 * Supports flexible model selection similar to OpenRouter:
 * - By vendor (e.g., "copilot")
 * - By family (e.g., "gpt-4o", "claude-3-5-sonnet", "o1")
 * - By specific model ID
 * - By version
 */
export class ModelHandlerVSCodeLM extends ModelHandler<VSCodeLMMessage> {
  private cachedModel: vscode.LanguageModelChat | null = null;

  /**
   * Creates and caches a VS Code Language Model client.
   * Parses the model configuration to determine vendor, family, id, or version.
   *
   * The fullName field can contain:
   * - Family name: "gpt-4o", "claude-3-5-sonnet", "o1"
   * - Vendor/family: "copilot/gpt-4o"
   * - Model ID: "copilot-gpt-4o"
   */
  async getClient(): Promise<vscode.LanguageModelChat> {
    if (this.cachedModel) {
      return this.cachedModel;
    }

    // Parse the fullName to build the selector
    const selector = this.parseModelSelector();

    const models = await vscode.lm.selectChatModels(selector);

    if (models.length === 0) {
      const selectorStr = JSON.stringify(selector);
      throw new Error(
        `No VS Code Language Model available for selector ${selectorStr}. Please ensure the required extension is enabled.`,
      );
    }

    // Use the first matching model
    this.cachedModel = models[0];
    this.logger.debug(
      `Selected VS Code LM: ${this.cachedModel.name} (vendor: ${this.cachedModel.vendor}, family: ${this.cachedModel.family})`,
    );

    return this.cachedModel;
  }

  /**
   * Parses the model configuration to build a VS Code Language Model selector.
   * Supports various formats:
   * - "gpt-4o" -> { family: "gpt-4o" }
   * - "copilot/gpt-4o" -> { vendor: "copilot", family: "gpt-4o" }
   * - "copilot-gpt-4o" (id) -> { id: "copilot-gpt-4o" }
   */
  private parseModelSelector(): VSCodeLMSelector {
    const fullName = this.config.fullName || 'gpt-4o';
    const selector: VSCodeLMSelector = {};

    // Check if it contains a vendor separator
    if (fullName.includes('/')) {
      const [vendor, family] = fullName.split('/');
      selector.vendor = vendor;
      selector.family = family;
    }
    else {
      // Treat the remaining value as the family name (default path)
      selector.family = fullName;
    }

    return selector;
  }

  /**
   * Generates a model response using VS Code's Language Model API.
   * Streams the response and aggregates it into a compatible format.
   */
  async createResponse(
    client: vscode.LanguageModelChat,
    messages: VSCodeLMMessage[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    _signal?: AbortSignal,
    _tools?: any[],
  ): Promise<VSCodeLMResponse> {
    try {
      // Convert messages to VS Code format
      const vscodeMessages = messages.map((msg) => {
        if (msg.role === 'user') {
          return vscode.LanguageModelChatMessage.User(msg.content);
        } else {
          return vscode.LanguageModelChatMessage.Assistant(msg.content);
        }
      });

      // Add system prompt as the first user message if provided
      if (systemPrompt && systemPrompt.trim().length > 0) {
        vscodeMessages.unshift(
          vscode.LanguageModelChatMessage.User(systemPrompt),
        );
      }

      // Send request with options
      const requestOptions: vscode.LanguageModelChatRequestOptions = {
        // VS Code API doesn't support temperature directly
        // We'll log a warning if it's not default
      };

      if (temperature !== 0 && temperature !== 1) {
        this.logger.warn(
          `Temperature ${temperature} is not supported by VS Code Language Model API`,
        );
      }

      // Note: VS Code uses CancellationToken, but we receive AbortSignal
      // For now, we don't pass the signal - VS Code manages cancellation internally
      const response = await client.sendRequest(vscodeMessages, requestOptions);

      // Aggregate the streamed response
      let fullText = '';

      // Create output stream if streaming is enabled
      const outputStream = this.outputStreaming
        ? this.createOutputStream()
        : null;

      for await (const chunk of response.text) {
        fullText += chunk;

        // Stream to output if enabled
        if (outputStream) {
          outputStream.append(chunk);
        }
      }

      // Finalize stream
      if (outputStream) {
        outputStream.finalize(fullText);
      }

      // Note: Don't append endTag here - it will be added in extractResponse
      // to avoid duplication and match other model handlers

      // Create compatible response object
      const copilotResponse: VSCodeLMResponse = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: fullText,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          // VS Code API doesn't provide token counts
          // We'll estimate based on characters
          prompt_tokens: Math.ceil(
            messages.reduce((sum, msg) => sum + msg.content.length, 0) / 4,
          ),
          completion_tokens: Math.ceil(fullText.length / 4),
          total_tokens: 0, // Will be calculated
        },
      };

      if (copilotResponse.usage) {
        copilotResponse.usage.total_tokens =
          (copilotResponse.usage.prompt_tokens || 0) +
          (copilotResponse.usage.completion_tokens || 0);
      }

      return copilotResponse;
    } catch (error: any) {
      // Handle cancellation
      if (_signal?.aborted || error?.name === 'AbortError') {
        throw new Error('Request was cancelled');
      }

      // Check for common VS Code API errors
      if (error?.message?.includes('No language model')) {
        throw new Error(
          'VS Code Language Model is not available. Please enable the required extension (e.g., GitHub Copilot).',
        );
      }

      throw error;
    }
  }

  /**
   * Initializes messages with user request and optional media.
   * Note: VS Code API currently has limited media support.
   */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: string[],
    _systemPrompt?: string,
  ): Promise<VSCodeLMMessage[]> {
    const content = userPrefix
      ? `${userPrefix}\n\n${userRequest}`
      : userRequest;

    // Log warning if media files are provided
    if (mediaFiles && mediaFiles.length > 0) {
      this.logger.warn(
        'Media files are not fully supported by VS Code Language Model API. Files will be ignored.',
      );
    }

    return [
      {
        role: 'user',
        content,
      },
    ];
  }

  /**
   * Creates follow-up messages for conversation rounds.
   */
  async createRoundMessages(
    messages: VSCodeLMMessage[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<VSCodeLMMessage[]> {
    if (mediaFiles && mediaFiles.length > 0) {
      this.logger.warn(
        'Media files are not fully supported by VS Code Language Model API.',
      );
    }

    return [
      ...messages,
      {
        role: 'user',
        content: userMessage,
      },
    ];
  }

  /**
   * Creates media content entries.
   * Currently not supported by VS Code API, returns empty array.
   */
  createMediaContent(_mediaMessage: MediaEntry[]): any[] {
    this.logger.warn('Media content is not supported by VS Code Language Model API');
    return [];
  }

  /**
   * Extracts response text and metadata from the model response.
   */
  extractResponse(
    responseObject: VSCodeLMResponse,
    endTag: string,
  ): [string, any, ProviderStopReason] {
    const message = responseObject.choices[0]?.message;
    if (!message) {
      throw new Error('No response message from VS Code LM');
    }

    let text = message.content || '';
    const finishReason = responseObject.choices[0]?.finish_reason || 'stop';

    // Ensure end tag is present
    if (endTag && !text.endsWith(endTag)) {
      const trimmedText = text.trimEnd();
      const separator = trimmedText.length > 0 ? '\n' : '';
      text = `${trimmedText}${separator}${endTag}`;
    }

    return [text, responseObject.usage || {}, finishReason as ProviderStopReason];
  }

  /**
   * Adds continuation message with prefill support.
   * VS Code Language Model API doesn't support prefill, so we use the without-prefill approach.
   */
  addContinueMessageWithPrefill(
    messages: VSCodeLMMessage[],
    stateRound: ConversationRoundState,
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void {
    // VS Code LM doesn't support prefill, delegate to without-prefill version
    this.addContinueMessageWithoutPrefill(
      messages,
      stateRound,
      workspaceState,
      agentSetting,
      agentConfig,
    );
  }

  /**
   * Adds continuation message without prefill support.
   */
  addContinueMessageWithoutPrefill(
    messages: VSCodeLMMessage[],
    stateRound: ConversationRoundState,
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void {
    // Create continuation message with last K tokens
    const prefillTokens = workspaceState.assembly.lastResponse.slice(-K_SLICE);
    const message = createContinuationMessage(
      agentSetting.endTag,
      prefillTokens,
    );

    messages.push({
      role: 'user',
      content: message,
    });

    stateRound.continuationCount++;
  }

  /**
   * Initializes output file and handles prefilling.
   */
  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: VSCodeLMMessage[],
    workspaceState: AgentWorkspaceState,
    outputFile: string,
    prefill: string,
  ): Promise<[boolean, VSCodeLMMessage[]]> {
    let endTurn = false;

    // Check if output file already exists with content
    if (!(await flexibleFS.existsAndNonTrivial(outputFile))) {
      // File doesn't exist or is empty - add prefill hint to last message
      if (prefill.trim().length > 0) {
        const pseudoPrefillMsg = `Organize your response with xml tags. Start your response with:\n${prefill}`;
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role === 'user') {
          lastMessage.content += `\n\n${pseudoPrefillMsg}`;
        } else {
          messages.push({
            role: 'user',
            content: pseudoPrefillMsg,
          });
        }
        this.logger.debug(
          `Added pseudo prefill message:\n${pseudoPrefillMsg}`,
        );
      }
      return [endTurn, messages];
    }

    // File exists with content - read and preserve it
    let fileContent = await flexibleFS.read(outputFile);
    fileContent = cleanFileContent(fileContent);

    // Extract any existing scratchpad content
    const scratchpad = await xmlUtils.extractScratchpad(
      fileContent,
      'scratchpad',
    );
    if (scratchpad) {
      this.logger.info(scratchpad, undefined, MESSAGE_TYPES.SCRATCHPAD);
    }

    // Write cleaned content back
    await flexibleFS.write(outputFile, fileContent);

    // Add existing content as assistant message
    messages.push({
      role: 'assistant',
      content: fileContent,
    });

    // Check if content is already complete (has end tag)
    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug('End tag detected - skipping continuation');
      endTurn = true;
      return [endTurn, messages];
    }

    // No end tag - will continue generation
    this.logger.warn(
      'Output file exists but no end tag found - continuing from file',
    );

    if (fileContent.includes(prefill)) {
      workspaceState.assembly.updateAccumulatedOutput(fileContent);
    } else {
      workspaceState.assembly.updateAccumulatedOutput(
        prefill + fileContent,
      );
      await flexibleFS.write(
        outputFile,
        workspaceState.assembly.accumulatedOutput,
      );
    }

    const state = new ConversationRoundState(0);
    workspaceState.assembly.lastResponse =
      workspaceState.assembly.accumulatedOutput;
    this.addContinueMessageWithoutPrefill(
      messages,
      state,
      workspaceState,
      agentSetting,
      agentConfig,
    );

    endTurn = false;
    return [endTurn, messages];
  }

  /**
   * Computes API usage cost.
   * VS Code LM doesn't charge per token, so we return 0.
   */
  computePrice(_responseUsage: any): number {
    return 0; // Pricing handled by the underlying service (e.g., Copilot subscription)
  }

  /**
   * Computes detailed usage metrics from response.
   */
  computeResponseUsage(
    responseUsage: any,
    responseTime: number,
  ): OpenAIAPIResponseUsage {
    const cost = this.computePrice(responseUsage);
    return ResponseUsageFactory.fromOpenAIResponse(
      responseUsage,
      cost,
      responseTime,
    );
  }

  /**
   * Updates message content with response (prefill version).
   */
  updateMessageContentWithPrefill(
    messages: VSCodeLMMessage[],
    bestConnector: string,
    newResponse: string,
    _workspaceState: AgentWorkspaceState,
  ): void {
    // VS Code LM doesn't support prefill, use regular append
    this.updateMessageContentWithoutPrefill(
      messages,
      bestConnector,
      newResponse,
      _workspaceState,
    );
  }

  /**
   * Updates message content with response (without prefill).
   * Properly handles continuation prompts to avoid accumulation in context.
   */
  updateMessageContentWithoutPrefill(
    messages: VSCodeLMMessage[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    this.logger.debug(
      'Updating message content for VS Code LM without prefill support',
    );

    const lastMessage = messages.at(-1);
    const secondLastMessage = messages.at(-2);

    // Check if last message is a user message (typical after continuation prompt)
    if (!lastMessage || lastMessage.role !== 'user') {
      this.logger.error(
        'Last message is not a user message - unexpected format',
      );
      return;
    }

    this.logger.debug('Last message is a user/system message');

    // Check if it's a continuation prompt
    if (this.containCutOffMessage(lastMessage.content)) {
      this.logger.debug(
        'Last message is a continuation prompt - appending to previous assistant message',
      );

      // Append to the second-last assistant message
      if (secondLastMessage && secondLastMessage.role === 'assistant') {
        secondLastMessage.content += bestConnector + newResponse;
      } else {
        this.logger.error(
          'Second last message is not an assistant message - unexpected format',
        );
        // Fallback: create new assistant message
        messages.push({
          role: 'assistant',
          content: workspaceState.assembly.accumulatedOutput,
        });
      }

      // Remove the continuation prompt to keep conversation clean
      messages.pop();
    } else {
      this.logger.debug(
        'Last message is a regular request - creating new assistant message',
      );
      // Not a continuation - create new assistant message
      messages.push({
        role: 'assistant',
        content: workspaceState.assembly.accumulatedOutput,
      });
    }
  }

  /**
   * Determines if generation should continue.
   */
  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    // Check if we hit a proper stop condition
    if (stopReason === OPENAI_CHAT_FINISH.STOP || stopReason === 'stop') {
      return false;
    }

    // Check for document end tag
    if (newResponse.includes(`</${agentSetting.documentTag}>`)) {
      return false;
    }

    // Continue for length or other reasons
    return stopReason === OPENAI_CHAT_FINISH.LENGTH || stopReason === 'length';
  }

  /**
   * Processes thinking blocks.
   * VS Code Language Model API doesn't expose thinking blocks.
   */
  processThinkingBlock(
    _responseObject: any,
    _workspaceState?: AgentWorkspaceState,
  ): string | null {
    return null;
  }

  /**
   * Extracts tool use information.
   * VS Code Language Model API doesn't support tools yet.
   */
  extractToolUse(_responseObject: any): string | null {
    return null;
  }

  /**
   * Creates tool use follow-up messages.
   * Not supported by VS Code Language Model API.
   */
  async createToolUseFollowUpMessages(
    _client: vscode.LanguageModelChat | undefined,
    _id: string,
    _name: string,
    _call: any,
    _result: Record<string, unknown>,
    _workspaceState?: AgentWorkspaceState,
    _text?: string,
  ): Promise<VSCodeLMMessage[]> {
    throw new Error('Tool use is not supported by VS Code Language Model API');
  }

  /**
   * Creates user follow-up messages.
   */
  async createUserFollowUpMessages(
    messages: VSCodeLMMessage[],
    userMessage: string,
  ): Promise<VSCodeLMMessage[]> {
    return [
      ...messages,
      {
        role: 'user',
        content: userMessage,
      },
    ];
  }

  /**
   * Creates a simple assistant message.
   */
  createAssistantMessage(text: string): VSCodeLMMessage {
    return {
      role: 'assistant',
      content: text,
    };
  }

  /**
   * Override getApiKey to indicate no API key is needed for VS Code LM
   */
  async getApiKey(): Promise<string> {
    // VS Code Language Model API uses VS Code's authentication, no API key needed
    return 'vscode-lm-integrated';
  }

  /**
   * Override getBaseUrl since VS Code LM doesn't use a base URL
   */
  getBaseUrl(): string | null {
    // VS Code Language Model API doesn't use base URLs
    return null;
  }
}
