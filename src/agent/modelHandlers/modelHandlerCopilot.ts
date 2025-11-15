// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting } from '@agent/core/AgentDataclass';
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

// Local file imports
import { ModelHandler } from './ModelHandler';
import { OPENAI_CHAT_FINISH } from './types/StopReasonTypes';
import type { ProviderStopReason } from './types/StopReasonTypes';

/**
 * Message format for VS Code Copilot API
 * Supports text content and simple structure
 */
interface CopilotMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Simulated response object to maintain compatibility with base class
 */
interface CopilotResponse {
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
 * Handler for VS Code Copilot models using the native Language Model API.
 * This provides seamless integration with VS Code's built-in Copilot capabilities.
 */
export class ModelHandlerCopilot extends ModelHandler<CopilotMessage> {
  private cachedModel: vscode.LanguageModelChat | null = null;

  /**
   * Creates and caches a VS Code Language Model client.
   * Uses the configured model family (default: gpt-4o)
   */
  async getClient(): Promise<vscode.LanguageModelChat> {
    if (this.cachedModel) {
      return this.cachedModel;
    }

    // Select the appropriate Copilot model
    // The fullName should be something like 'gpt-4o', 'gpt-4', etc.
    const modelFamily = this.config.fullName || 'gpt-4o';

    const [model] = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: modelFamily,
    });

    if (!model) {
      throw new Error(
        `No Copilot model available for family "${modelFamily}". Please ensure GitHub Copilot is enabled.`,
      );
    }

    this.cachedModel = model;
    this.logger.debug(
      `Selected Copilot model: ${model.name} (family: ${model.family})`,
    );

    return model;
  }

  /**
   * Generates a model response using VS Code's Language Model API.
   * Streams the response and aggregates it into a compatible format.
   */
  async createResponse(
    client: vscode.LanguageModelChat,
    messages: CopilotMessage[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    _signal?: AbortSignal,
    _tools?: any[],
  ): Promise<CopilotResponse> {
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
      let tokenCount = 0;

      // Create output stream if streaming is enabled
      const outputStream = this.outputStreaming
        ? this.createOutputStream()
        : null;

      for await (const chunk of response.text) {
        fullText += chunk;
        tokenCount++;

        // Stream to output if enabled
        if (outputStream) {
          outputStream.append(chunk);
        }
      }

      // Finalize stream
      if (outputStream) {
        outputStream.finalize(fullText);
      }

      // Append end tag if specified
      if (endTag && !fullText.endsWith(endTag)) {
        fullText += endTag;
      }

      // Create compatible response object
      const copilotResponse: CopilotResponse = {
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
          'GitHub Copilot is not available. Please sign in to GitHub Copilot.',
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
  ): Promise<CopilotMessage[]> {
    let content = userPrefix ? `${userPrefix}\n\n${userRequest}` : userRequest;

    // Log warning if media files are provided
    if (mediaFiles && mediaFiles.length > 0) {
      this.logger.warn(
        'Media files are not fully supported by VS Code Copilot API. Files will be ignored.',
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
    messages: CopilotMessage[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<CopilotMessage[]> {
    if (mediaFiles && mediaFiles.length > 0) {
      this.logger.warn(
        'Media files are not fully supported by VS Code Copilot API.',
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
    this.logger.warn('Media content is not supported by VS Code Copilot API');
    return [];
  }

  /**
   * Extracts response text and metadata from the model response.
   */
  extractResponse(
    responseObject: CopilotResponse,
    endTag: string,
  ): [string, any, ProviderStopReason] {
    const message = responseObject.choices[0]?.message;
    if (!message) {
      throw new Error('No response message from Copilot');
    }

    let text = message.content || '';
    const finishReason = responseObject.choices[0]?.finish_reason || 'stop';

    // Ensure end tag is present
    if (endTag && !text.endsWith(endTag)) {
      text += endTag;
    }

    return [text, responseObject.usage || {}, finishReason as ProviderStopReason];
  }

  /**
   * Adds continuation message with prefill support.
   * Copilot API doesn't support prefill, so we use the without-prefill approach.
   */
  addContinueMessageWithPrefill(
    messages: CopilotMessage[],
    stateRound: ConversationRoundState,
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void {
    // Copilot doesn't support prefill, delegate to without-prefill version
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
    messages: CopilotMessage[],
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
    messages: CopilotMessage[],
    workspaceState: AgentWorkspaceState,
    outputFile: string,
    prefill: string,
  ): Promise<[boolean, CopilotMessage[]]> {
    // Create or clear output file
    await flexibleFS.write(outputFile, '');

    // Copilot doesn't support prefill in the same way
    // We can add it as a user message hint
    if (prefill.trim().length > 0) {
      messages.push({
        role: 'user',
        content: `Please start your response with: ${prefill}`,
      });
    }

    return [false, messages];
  }

  /**
   * Computes API usage cost.
   * Copilot doesn't charge per token, so we return 0.
   */
  computePrice(_responseUsage: any): number {
    return 0; // Copilot is included with GitHub Copilot subscription
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
    messages: CopilotMessage[],
    bestConnector: string,
    newResponse: string,
    _workspaceState: AgentWorkspaceState,
  ): void {
    // Copilot doesn't support prefill, use regular append
    this.updateMessageContentWithoutPrefill(
      messages,
      bestConnector,
      newResponse,
      _workspaceState,
    );
  }

  /**
   * Updates message content with response (without prefill).
   */
  updateMessageContentWithoutPrefill(
    messages: CopilotMessage[],
    bestConnector: string,
    newResponse: string,
    _workspaceState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages[messages.length - 1];

    if (lastMessage && lastMessage.role === 'assistant') {
      // Append to existing assistant message
      lastMessage.content += bestConnector + newResponse;
    } else {
      // Create new assistant message
      messages.push({
        role: 'assistant',
        content: newResponse,
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
   * Copilot API doesn't expose thinking blocks.
   */
  processThinkingBlock(
    _responseObject: any,
    _workspaceState?: AgentWorkspaceState,
  ): string | null {
    return null;
  }

  /**
   * Extracts tool use information.
   * Copilot API doesn't support tools yet.
   */
  extractToolUse(_responseObject: any): string | null {
    return null;
  }

  /**
   * Creates tool use follow-up messages.
   * Not supported by Copilot API.
   */
  async createToolUseFollowUpMessages(
    _client: vscode.LanguageModelChat | undefined,
    _id: string,
    _name: string,
    _call: any,
    _result: Record<string, unknown>,
    _workspaceState?: AgentWorkspaceState,
    _text?: string,
  ): Promise<CopilotMessage[]> {
    throw new Error('Tool use is not supported by VS Code Copilot API');
  }

  /**
   * Creates user follow-up messages.
   */
  async createUserFollowUpMessages(
    messages: CopilotMessage[],
    userMessage: string,
  ): Promise<CopilotMessage[]> {
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
  createAssistantMessage(text: string): CopilotMessage {
    return {
      role: 'assistant',
      content: text,
    };
  }

  /**
   * Override getApiKey to indicate no API key is needed for Copilot
   */
  async getApiKey(): Promise<string> {
    // Copilot uses VS Code's authentication, no API key needed
    return 'copilot-integrated';
  }

  /**
   * Override getBaseUrl since Copilot doesn't use a base URL
   */
  getBaseUrl(): string | null {
    return null;
  }
}
