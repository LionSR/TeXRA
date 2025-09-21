// Standard library imports
import { Buffer } from 'node:buffer';

// Third-party imports
import OpenAI, { toFile } from 'openai';
import type {
  Response,
  ResponseUsage,
  ResponseCreateParamsBase,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputText,
  ResponseReasoningItem,
  ResponseFunctionToolCallItem,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseInputContent,
  ResponseInputMessageContentList,
  ResponseInputFile,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

// Local imports - agent
import type { AgentConfig } from '../core/AgentConfig';
import type { AgentSetting } from '../core/AgentDataclass';
import { hasEndTag } from '../core/AgentDataclass';
import { AgentStateRound } from '../core/AgentState';
import {
  ResponseUsageFactory,
  type OpenAIAPIResponseUsage,
  type ExtendedCompletionUsage,
} from '../core/ResponseUsage';
import { ToolState } from '../core/ToolState';

// Local imports - base handler
import { ModelHandler } from './ModelHandler';
import { toOpenAIResponseTools } from './toolConversion';
import type { ProviderStopReason } from './types/StopReasonTypes';
import { OPENAI_CHAT_FINISH } from './types/StopReasonTypes';

// Local imports - utilities
import { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { ToolDefinition } from '@model';
import { cleanFileContent } from '@replacement/engine';
import { K_SLICE, getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';
import xmlUtils from '@utils/text/xmlUtils';

/**
 * Handler for OpenAI's Responses API. This implementation works directly with
 * the native response message types instead of reusing the chat completion
 * abstractions. Conversation state is maintained through `previous_response_id`
 * so we only submit the new messages for each turn.
 */
export class ModelHandlerOpenAIResponse extends ModelHandler<
  ResponseInputItem,
  ResponseUsage | undefined,
  OpenAIAPIResponseUsage,
  ResponseFunctionToolCallItem
> {
  private previousResponseId: string | null = null;
  private sentMessages = 0;

  /**
   * Manually set the previous response ID to resume a conversation.
   * Call with `null` to reset the stored ID.
   */
  setPreviousResponseId(id: string | null): void {
    this.previousResponseId = id;
    this.sentMessages = 0;
  }

  /** Retrieve the stored previous response ID. */
  getPreviousResponseId(): string | null {
    return this.previousResponseId;
  }

  /** Creates a configured OpenAI client instance. */
  protected async createOpenAIClient(
    providerName: string = this.config.provider,
  ): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl();
    this.logger.debug(`Using ${providerName} API key. Base URL: ${baseURL}`);
    return new OpenAI({ apiKey, baseURL });
  }

  /** Returns OpenAI client with configured API key. */
  async getClient(): Promise<OpenAI> {
    return this.createOpenAIClient();
  }

  /** Reset conversation bookkeeping when starting a new session. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: string[],
    systemPrompt?: string,
  ): Promise<ResponseInputItem[]> {
    this.previousResponseId = null;
    this.sentMessages = 0;

    const messages: ResponseInputItem[] = [];

    if (systemPrompt) {
      const role = this.capabilities.supportsSystemPrompt ? 'system' : 'user';
      messages.push({
        type: 'message',
        role,
        content: [
          this.createInputText(systemPrompt),
        ] as ResponseInputMessageContentList,
      } as ResponseInputItem);
    }

    const supportsMedia =
      this.capabilities.supportsVision || this.capabilities.supportsNativeAudio;
    const userContent: ResponseInputMessageContentList = [
      this.createInputText(userPrefix),
    ];

    if (mediaFiles && mediaFiles.length > 0 && supportsMedia) {
      try {
        const mediaContent = (await this.createMediaMessage(
          mediaFiles,
        )) as ResponseInputMessageContentList;
        userContent.push(...mediaContent);
      } catch (err) {
        this.logger.error(
          `Error processing media files: ${getSdkErrorMessage(err)}`,
          undefined,
          undefined,
          err,
        );
      }
    }

    if (userContent.length > 0) {
      messages.push({
        type: 'message',
        role: 'user',
        content: userContent,
      } as ResponseInputItem);
    }

    const requestRole = this.capabilities.supportsIntermDevMsgs
      ? 'system'
      : 'user';

    if (requestRole === 'user' && messages.length > 0) {
      this.appendInputText(messages.at(-1)!, userRequest);
    } else {
      messages.push({
        type: 'message',
        role: requestRole,
        content: [
          this.createInputText(userRequest),
        ] as ResponseInputMessageContentList,
      } as ResponseInputItem);
    }

    return messages;
  }

  /** Adds user message content for subsequent rounds. */
  async createRoundMessages(
    messages: ResponseInputItem[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<ResponseInputItem[]> {
    const roundContent: ResponseInputMessageContentList = [];

    if (
      mediaFiles &&
      mediaFiles.length > 0 &&
      (this.capabilities.supportsVision ||
        this.capabilities.supportsNativeAudio)
    ) {
      try {
        const formattedMediaContent = (await this.createMediaMessage(
          mediaFiles,
        )) as ResponseInputMessageContentList;
        roundContent.push(...formattedMediaContent);
      } catch (err) {
        this.logger.error(
          `Error processing media files for follow-up round: ${getSdkErrorMessage(err)}`,
          undefined,
          undefined,
          err,
        );
      }
    }

    roundContent.push(this.createInputText(userMessage));

    messages.push({
      type: 'message',
      role: 'user',
      content: roundContent,
    } as ResponseInputItem);

    return messages;
  }

  /** Formats image/audio content for the Responses API. */
  createMediaContent(mediaMessage: MediaEntry[]): ResponseInputContent[] {
    return mediaMessage.flatMap((media): ResponseInputContent[] => {
      if (media.media_category === 'image') {
        return [
          this.createInputText(`Image: ${media.file_name}`),
          {
            type: 'input_image',
            image_url: `data:${media.media_type};base64,${media.data}`,
            detail: 'high',
          },
        ];
      }

      if (media.media_category === 'audio') {
        if (!this.capabilities.supportsNativeAudio) {
          this.logger.warn(
            `Audio input received (${media.file_name}) but native audio is not supported by this model/provider (${this.config.provider}). Skipping.`,
          );
          return [];
        }

        let audioFormat = media.media_type;
        if (media.media_type.includes('/')) {
          audioFormat = media.media_type.split('/')[1];
        }

        const normalizedFormat =
          audioFormat === 'mp3' || audioFormat === 'wav'
            ? audioFormat
            : undefined;
        if (!normalizedFormat) {
          this.logger.warn(
            `Audio input received (${media.file_name}) with unsupported format (${audioFormat}). Skipping.`,
          );
          return [];
        }

        return [
          this.createInputText(`Audio: ${media.file_name}`),
          {
            type: 'input_audio',
            input_audio: {
              data: media.data,
              format: normalizedFormat,
            },
          },
        ];
      }

      if (media.media_type === 'application/pdf') {
        return [
          this.createInputText(`Document: ${media.file_name}`),
          {
            type: 'input_file',
            file_data: media.data,
            filename: media.file_name,
          },
        ];
      }

      this.logger.warn(`Unknown media category: ${media.media_category}`);
      return [];
    });
  }

  private isInputFileContent(
    content: ResponseInputContent,
  ): content is ResponseInputFile {
    return content.type === 'input_file';
  }

  private async uploadInlineInputFiles(
    client: OpenAI,
    messageItems: ResponseInputItem[],
  ): Promise<void> {
    for (const item of messageItems) {
      if (!this.isMessageItem(item)) {
        continue;
      }

      const contentList = (
        item as ResponseInputItem & {
          content?: ResponseInputMessageContentList;
        }
      ).content;

      if (!Array.isArray(contentList)) {
        continue;
      }

      for (const content of contentList) {
        if (
          this.isInputFileContent(content) &&
          content.file_data &&
          !content.file_id
        ) {
          await this.replaceFileDataWithUpload(client, content);
        }
      }
    }
  }

  private async replaceFileDataWithUpload(
    client: OpenAI,
    content: ResponseInputFile,
  ): Promise<void> {
    const fileData = content.file_data;
    if (!fileData) {
      return;
    }

    const filename = content.filename ?? 'document.pdf';
    let buffer: Buffer | undefined;

    try {
      const base64Separator = ';base64,';
      const separatorIndex = fileData.indexOf(base64Separator);
      const payload =
        separatorIndex >= 0
          ? fileData.slice(separatorIndex + base64Separator.length)
          : fileData;

      buffer = Buffer.from(payload, 'base64');
      const uploadedFile = await client.files.create({
        file: await toFile(buffer, filename),
        purpose: 'assistants',
      });

      content.file_id = uploadedFile.id;
      delete content.file_data;
    } catch (err) {
      this.logger.error(
        `Failed to upload file ${filename}: ${getSdkErrorMessage(err)}`,
        undefined,
        undefined,
        err,
      );
      throw err;
    } finally {
      if (buffer) {
        buffer.fill(0);
        buffer = undefined;
      }
    }
  }

  /**
   * Create a response using the Responses API.
   * The handler submits only the messages that were not part of the previous
   * request and relies on `previous_response_id` for conversation context.
   */
  async createResponse(
    client: OpenAI,
    messages: ResponseInputItem[],
    temperature: number,
    systemPrompt?: string,
    _endTag?: string,
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): Promise<Response> {
    const useStreaming = this.getStreamingConfig();
    const newMessages = messages.slice(this.sentMessages);

    await this.uploadInlineInputFiles(client, newMessages);

    const params: ResponseCreateParamsBase = {
      model: this.config.fullName,
      input: newMessages,
      max_output_tokens: this.config.maxOutputTokens,
      store: true,
    };

    if (!this.isOReasoningModel) {
      params.temperature = temperature;
    }

    if (this.previousResponseId) {
      params.previous_response_id = this.previousResponseId;
    }

    if (systemPrompt) {
      params.instructions = systemPrompt;
    }

    if (tools && tools.length > 0) {
      params.tools = toOpenAIResponseTools(tools);
      params.tool_choice = 'auto';
    }

    if (this.capabilities.supportsReasoning) {
      const isGpt5 = this.config.name.startsWith('gpt5');
      const includeSummary =
        !isGpt5 || getConfig<boolean>('model.gpt5ReasoningSummary', false);
      params.reasoning = {};
      if (includeSummary) {
        (params.reasoning as Record<string, unknown>).summary = 'auto';
      }
      if (this.capabilities.supportsReasoningEffort) {
        (params.reasoning as Record<string, unknown>).effort = 'high';
      }
    }

    if (useStreaming) {
      const stream = client.responses.stream(params, { signal });
      const groupId = this.logger.getActiveGroupId();
      const thinking = this.createThinkingStream(groupId);
      const output = this.isOutputStreamingEnabled()
        ? this.createOutputStream(groupId)
        : undefined;
      const responseStream: AsyncIterable<ResponseStreamEvent> = stream;
      for await (const event of responseStream) {
        switch (event.type) {
          case 'response.reasoning_text.delta':
          case 'response.reasoning_summary_text.delta': {
            thinking.append(event.delta);
            break;
          }
          case 'response.output_text.delta': {
            output?.append(event.delta);
            break;
          }
          default:
            break;
        }
      }

      const response = await stream.finalResponse();
      const finalReasoning = this.processThinkingBlock(response);
      thinking.finalize(finalReasoning ?? undefined);
      const [finalText] = this.extractResponse(response, '');
      if (output) output.finalize(finalText);

      this.previousResponseId = response.id;
      this.sentMessages = messages.length;
      return response;
    }

    try {
      const response = await client.responses.create(params, { signal });
      this.previousResponseId = response.id;
      this.sentMessages = messages.length;
      return response;
    } catch (err) {
      this.logger.error(
        `Error in createResponse: ${getSdkErrorMessage(err)}`,
        undefined,
        undefined,
        err,
      );
      throw err;
    }
  }

  /**
   * Extract plain text and usage information from the Responses API result.
   */
  extractResponse(
    responseObject: Response,
    endTag: string,
  ): [string, ResponseUsage | undefined, ProviderStopReason] {
    const usage = responseObject.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    };

    let newResponse = '';

    if (responseObject.output_text) {
      newResponse = responseObject.output_text.trim();
    } else if (Array.isArray(responseObject.output)) {
      const messageParts = responseObject.output.filter(
        (part): part is ResponseOutputMessage =>
          part.type === 'message' && 'content' in part,
      );
      if (messageParts.length > 0) {
        const aggregated = messageParts
          .map((part) => this.extractMessageText(part.content))
          .filter((content) => content.length > 0)
          .join('');
        newResponse = aggregated.trim();
      } else {
        const fallbackText = responseObject.output
          .filter(
            (
              part,
            ): part is ResponseOutputItem & { text: string; type: string } =>
              this.isTextBearingOutput(part) && part.type !== 'reasoning',
          )
          .map((part) => part.text)
          .join('');
        newResponse = fallbackText.trim();
      }
    }

    const stopReason =
      responseObject.status === 'completed'
        ? OPENAI_CHAT_FINISH.STOP
        : OPENAI_CHAT_FINISH.LENGTH;

    if (
      stopReason === OPENAI_CHAT_FINISH.STOP &&
      endTag &&
      !newResponse.includes(endTag)
    ) {
      return [`${newResponse}\n${endTag}`, usage, stopReason];
    }

    return [newResponse, usage, stopReason];
  }

  private extractMessageText(
    content: ResponseOutputMessage['content'] | string | undefined,
  ): string {
    if (!content) {
      return '';
    }

    if (typeof content === 'string') {
      return content;
    }

    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .filter(
        (item): item is ResponseOutputText =>
          item?.type === 'output_text' && typeof item?.text === 'string',
      )
      .map((item) => item.text)
      .join('');
  }

  private isTextBearingOutput(
    part: ResponseOutputItem,
  ): part is ResponseOutputItem & { text: string; type: string } {
    return (
      typeof (part as { text?: unknown }).text === 'string' &&
      typeof (part as { type?: unknown }).type === 'string'
    );
  }

  /** Price computation adapted for Responses API token fields. */
  computePrice(responseUsage: ResponseUsage | undefined): number {
    if (!responseUsage) {
      return 0.0;
    }

    const promptTokens = responseUsage.input_tokens ?? 0;
    const completionTokens = responseUsage.output_tokens ?? 0;

    let basePrice = calculateTokenPrice(
      promptTokens,
      completionTokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );

    const reasoningTokens =
      responseUsage.output_tokens_details?.reasoning_tokens ?? 0;
    const cachedTokens = responseUsage.input_tokens_details?.cached_tokens ?? 0;

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

  /** Map usage fields and create usage statistics object. */
  computeResponseUsage(
    responseUsage: ResponseUsage | undefined,
    responseTime: number,
  ): OpenAIAPIResponseUsage {
    if (!responseUsage) {
      const emptyUsage: ExtendedCompletionUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
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

    const mapped: ExtendedCompletionUsage = {
      prompt_tokens: responseUsage.input_tokens ?? 0,
      completion_tokens: responseUsage.output_tokens ?? 0,
      total_tokens: responseUsage.total_tokens ?? 0,
      prompt_tokens_details: {
        cached_tokens: responseUsage.input_tokens_details?.cached_tokens ?? 0,
      },
      completion_tokens_details: {
        reasoning_tokens:
          responseUsage.output_tokens_details?.reasoning_tokens ?? 0,
        accepted_prediction_tokens: undefined,
        rejected_prediction_tokens: undefined,
      },
    };

    return ResponseUsageFactory.fromOpenAIResponse(
      mapped,
      this.computePrice(responseUsage),
      responseTime,
    );
  }

  /** Models with prefill support do not require additional continuation messages. */
  addContinueMessageWithPrefill(
    _messages: ResponseInputItem[],
    _stateRound: AgentStateRound,
    _toolState: ToolState,
    _agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    this.logger.debug('Skipping continuation - assistant prefill is supported');
  }

  /** Adds continuation instructions for models without prefill support. */
  addContinueMessageWithoutPrefill(
    messages: ResponseInputItem[],
    _stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    const prefillTokens = toolState.lastResponse.slice(-K_SLICE);
    const userMessageContinuation =
      `Your response got cut off, because you only have limited response space. ` +
      `Continue responding exactly from where you left off until the very end, ` +
      `marked by ${agentSetting.endTag}. ` +
      'Avoid repeat yourself and avoid starting over. ' +
      `Start your response at the next token after: "${prefillTokens}"`;

    const role = this.capabilities.supportsIntermDevMsgs ? 'system' : 'user';
    messages.push({
      type: 'message',
      role,
      content: [
        this.createInputText(userMessageContinuation),
      ] as ResponseInputMessageContentList,
    } as ResponseInputItem);
  }

  /** Initializes output file and handles prefill content. */
  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: ResponseInputItem[],
    toolState: ToolState,
    outputFile: string,
    prefill: string,
    groupId?: string,
  ): Promise<[boolean, ResponseInputItem[]]> {
    let endTurn = false;

    if (!(await WorkspaceFS.existsAndNonTrivial(outputFile))) {
      const pseudoPrefill = `Organize your response with xml tags. Start your response with:\n${prefill}`;
      const lastMessage = messages.at(-1);
      if (lastMessage) {
        this.appendInputText(lastMessage, pseudoPrefill);
      } else {
        messages.push({
          type: 'message',
          role: 'user',
          content: [
            this.createInputText(pseudoPrefill),
          ] as ResponseInputMessageContentList,
        } as ResponseInputItem);
      }
      this.logger.debug(
        `Added pseudo prefill message to messages:\n${pseudoPrefill}`,
      );
      return [endTurn, messages];
    }

    let fileContent = await WorkspaceFS.read(outputFile);
    fileContent = cleanFileContent(fileContent);

    const scratchpad = await xmlUtils.extractScratchpad(
      fileContent,
      'scratchpad',
    );
    if (scratchpad) {
      this.logger.info(scratchpad, groupId, MESSAGE_TYPES.SCRATCHPAD);
    }

    await WorkspaceFS.write(outputFile, fileContent);

    messages.push(this.createAssistantMessage(fileContent));

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug('End tag detected - skipping continuation');
      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.warn(
      'Output file exists but no end tag found - continuing from file',
    );
    if (fileContent.includes(prefill)) {
      toolState.updateAccumulatedOutput(fileContent);
    } else {
      toolState.updateAccumulatedOutput(prefill + fileContent);
      await WorkspaceFS.write(outputFile, toolState.accumulatedOutput);
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

  /** Updates message content for models with prefill support. */
  updateMessageContentWithPrefill(
    messages: ResponseInputItem[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void {
    this.logger.debug(
      'Updating message content for OpenAI Responses models with prefill support',
    );

    const lastMessage = messages.at(-1);
    if (
      lastMessage &&
      this.appendAssistantText(lastMessage, `${bestConnector}${newResponse}`)
    ) {
      return;
    }

    messages.push(this.createAssistantMessage(toolState.accumulatedOutput));
  }

  /** Updates message content for models without prefill support. */
  updateMessageContentWithoutPrefill(
    messages: ResponseInputItem[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void {
    this.logger.debug(
      'Updating message content for OpenAI Responses models without prefill support',
    );

    const lastMessage = messages.at(-1);
    const secondLastMessage = messages.at(-2);

    if (!lastMessage || !this.isMessageItem(lastMessage)) {
      this.logger.error(
        'Last message is not a message item - unexpected format',
      );
      return;
    }

    if (this.containCutOffMessage((lastMessage as any).content)) {
      this.logger.debug(
        'Last message is a user message asking to continue after cut off',
      );
      if (secondLastMessage) {
        const appended = this.appendAssistantText(
          secondLastMessage,
          `${bestConnector}${newResponse}`,
        );
        if (
          this.isMessageItem(messages.at(-1)) &&
          (messages.at(-1) as any).role === 'user'
        ) {
          messages.pop();
        } else if (!appended) {
          messages.push(
            this.createAssistantMessage(toolState.accumulatedOutput),
          );
        }
      }
    } else {
      this.logger.debug(
        'Last message is a request message rather than a continuation request',
      );
      messages.push(this.createAssistantMessage(toolState.accumulatedOutput));
    }
  }

  /** Determines if generation should continue based on response content. */
  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    return (
      stopReason === OPENAI_CHAT_FINISH.LENGTH &&
      !hasEndTag(agentSetting, newResponse)
    );
  }

  /** Process reasoning summaries from the Responses API. */
  processThinkingBlock(
    responseObject: Response,
    groupId?: string,
    toolState?: ToolState,
  ): string | null {
    const outputArr = responseObject?.output;
    if (!Array.isArray(outputArr)) {
      return null;
    }
    const reasoningObj = outputArr.find(
      (item) => item?.type === 'reasoning',
    ) as ResponseReasoningItem | undefined;
    const summaryParts = reasoningObj?.summary;
    if (!Array.isArray(summaryParts) || summaryParts.length === 0) {
      return null;
    }

    const thoughtContent = summaryParts
      .map((part: any) =>
        part.type === 'summary_text' && typeof part?.text === 'string'
          ? part.text
          : '',
      )
      .join('')
      .trim();

    if (toolState && !toolState.thinkingAdded) {
      toolState.thinkingBlocks = summaryParts.map((part) => ({
        type: 'thinking',
        thinking: typeof part?.text === 'string' ? part.text : '',
      }));
      toolState.thinkingAdded = true;
    }

    if (thoughtContent) {
      this.logger.debug(
        `OpenAI Responses reasoning preview: ${thoughtContent.substring(0, K_SLICE)}...`,
        groupId,
      );
    }

    return thoughtContent || null;
  }

  extractToolUse(response: Response): string | null {
    const items = response?.output;
    if (!Array.isArray(items)) return null;

    const call = items.find(
      (it): it is ResponseFunctionToolCallItem => it?.type === 'function_call',
    );
    return call ? JSON.stringify(call, null, 2) : null;
  }

  createToolUseFollowUpMessages(
    id: string,
    name: string,
    call: ResponseFunctionToolCallItem,
    result: Record<string, unknown>,
    _toolState?: ToolState,
    text?: string,
  ): ResponseInputItem[] {
    const messages: ResponseInputItem[] = [];
    if (text) {
      messages.push(this.createAssistantMessage(text));
    }

    const callMsg: ResponseFunctionToolCall = {
      type: 'function_call',
      call_id: id,
      name,
      arguments:
        typeof call?.arguments === 'string'
          ? call.arguments
          : JSON.stringify(
              (call as unknown as { input?: unknown; arguments?: unknown })
                ?.input ??
                (call as unknown as { input?: unknown; arguments?: unknown })
                  ?.arguments ??
                {},
            ),
    };

    const resultMsg: ResponseInputItem.FunctionCallOutput = {
      type: 'function_call_output',
      call_id: id,
      output: JSON.stringify(result),
    };

    messages.push(callMsg, resultMsg);
    return messages;
  }

  async createUserFollowUpMessages(
    messages: ResponseInputItem[],
    userMessage: string,
  ): Promise<ResponseInputItem[]> {
    messages.push({
      type: 'message',
      role: 'user',
      content: [
        this.createInputText(userMessage),
      ] as ResponseInputMessageContentList,
    } as ResponseInputItem);
    return messages;
  }

  createAssistantMessage(text: string): ResponseInputItem {
    const content: ResponseInputMessageContentList = [
      this.createInputText(text),
    ];

    return {
      type: 'message',
      role: 'assistant',
      content,
    } satisfies ResponseInputItem;
  }

  private createInputText(text: string): ResponseInputContent {
    return { type: 'input_text', text };
  }

  private isMessageItem(item?: ResponseInputItem): item is ResponseInputItem & {
    type?: 'message';
    role?: string;
    content?: unknown;
  } {
    if (!item || typeof item !== 'object') {
      return false;
    }
    const candidate = item as any;
    return typeof candidate.role === 'string';
  }

  private appendInputText(message: ResponseInputItem, text: string): void {
    if (!this.isMessageItem(message)) {
      return;
    }

    const messageWithContent = message as ResponseInputItem & {
      content?: ResponseInputMessageContentList | string;
    };
    const { content } = messageWithContent;

    if (Array.isArray(content)) {
      content.push(this.createInputText(text));
      return;
    }

    if (typeof content === 'string') {
      messageWithContent.content = [
        this.createInputText(content),
        this.createInputText(text),
      ];
      return;
    }

    messageWithContent.content = [this.createInputText(text)];
  }

  private appendAssistantText(
    message: ResponseInputItem,
    text: string,
  ): boolean {
    if (!this.isMessageItem(message)) {
      return false;
    }

    const assistantMessage = message as ResponseInputItem & {
      role?: string;
      content?: ResponseInputMessageContentList | string;
    };

    if (assistantMessage.role !== 'assistant') {
      return false;
    }

    const newContent = this.createInputText(text);

    if (Array.isArray(assistantMessage.content)) {
      assistantMessage.content.push(newContent);
      return true;
    }

    if (typeof assistantMessage.content === 'string') {
      assistantMessage.content = [
        this.createInputText(assistantMessage.content),
        newContent,
      ];
      return true;
    }

    assistantMessage.content = [newContent];
    return true;
  }
}
