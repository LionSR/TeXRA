// Standard library imports
import { Buffer } from 'node:buffer';

// Third-party imports
import OpenAI, { toFile } from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionAssistantMessageParam,
  ChatCompletionToolMessageParam,
} from 'openai/resources/chat/completions';
import type {
  Response,
  ResponseUsage,
  ResponseOutputMessage,
  ResponseOutputText,
  ResponseReasoningItem,
  ResponseFunctionToolCallItem,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

// Local imports - agent
import { ResponseUsageFactory } from '../core/ResponseUsage';
import { ToolState } from '../core/ToolState';

// Local imports - base handler
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { toOpenAIResponseTools } from './toolConversion';
import type { ProviderStopReason } from './types/StopReasonTypes';
import { OPENAI_CHAT_FINISH } from './types/StopReasonTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import { logErrorMessage } from '@common/errors/errorHandlingUtils';
import type { ToolDefinition } from '@model';
import { K_SLICE, getConfig } from '@utils/config';

// import { ResponseCreateParams } from 'openai/src/resources/responses/response';
// this is incorrect now, but would be nice to use

/**
 * Handler for OpenAI's new Responses API. Uses `previous_response_id` to
 * manage conversation state between calls.
 *
 * This class extends ModelHandlerOpenAI to maintain compatibility with the
 * existing message handling infrastructure while adapting to the Responses API's
 * different message format. The base class works with ChatCompletionMessageParam[],
 * but the Responses API requires ResponseInputItem[]. All conversion happens
 * internally in the createResponse method.
 *
 * Note: PDFs are handled specially - they are converted from image_url format
 * to input_file format with mime_type 'application/pdf' for proper processing.
 */
export class ModelHandlerOpenAIResponse extends ModelHandlerOpenAI {
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

  /** Reset conversation state when starting new messages. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: string[],
    systemPrompt?: string,
  ): Promise<ResponseInputItem[]> {
    this.previousResponseId = null;
    this.sentMessages = 0;
    return super.initializeMessages(
      userPrefix,
      userRequest,
      mediaFiles,
      systemPrompt,
    );
  }

  /**
   * Create a response using the Responses API.
   *
   * IMPORTANT: This method maintains the base class signature for compatibility,
   * accepting ChatCompletionMessageParam[] even though the Responses API requires
   * ResponseInputItem[]. The conversion is handled internally to preserve the
   * inheritance hierarchy and allow seamless integration with the existing infrastructure.
   *
   * The conversion handles:
   * - Text content: 'text' -> 'input_text' or 'output_text' based on role
   * - Images: 'image_url' -> 'input_image'
   * - PDFs: Special handling to convert from image_url to input_file format
   *
   * @param messages ChatCompletionMessageParam[] from base class methods
   * @returns Response object from the Responses API
   */
  async createResponse(
    client: OpenAI,
    messages: ChatCompletionMessageParam[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): Promise<Response> {
    const useStreaming = this.getStreamingConfig();

    const newMessages = await Promise.all(
      messages.slice(this.sentMessages).map(async (msg) => {
        if ('role' in msg) {
          const content =
            typeof msg.content === 'string'
              ? [{ type: 'input_text', text: msg.content }]
              : Array.isArray(msg.content)
                ? await Promise.all(
                    msg.content.map(async (part: any) => {
                      if (part.type === 'text') {
                        if (msg.role === 'user') {
                          return { type: 'input_text', text: part.text };
                        } else if (msg.role === 'assistant') {
                          return { type: 'output_text', text: part.text };
                        } else {
                          return { type: 'input_text', text: part.text };
                        }
                      }
                      if (part.type === 'image_url') {
                        const url =
                          typeof part.image_url === 'string'
                            ? part.image_url
                            : part.image_url.url;

                        if (url.startsWith('data:application/pdf;base64,')) {
                          const base64Data = url.replace(
                            'data:application/pdf;base64,',
                            '',
                          );
                          let buffer: Buffer | undefined = Buffer.from(
                            base64Data,
                            'base64',
                          );
                          try {
                            const uploadedFile = await client.files.create({
                              file: await toFile(buffer, 'upload.pdf'),
                              purpose: 'assistants',
                            });
                            return {
                              type: 'input_file',
                              file_id: uploadedFile.id,
                            };
                          } catch (err) {
                            logErrorMessage(
                              'OpenAI',
                              'Failed to upload PDF',
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

                        const detail = part.image_url?.detail ?? 'auto';
                        return { type: 'input_image', image_url: url, detail };
                      }
                      return part;
                    }),
                  )
                : [];
          return { role: msg.role, content };
        }
        return msg;
      }),
    );

    const params: any = {
      model: this.config.fullName,
      input: newMessages,
      max_output_tokens: this.config.maxOutputTokens,
      store: true,
    };

    // The Responses API does not currently support stop sequences. We keep the
    // end tag for post-processing only and do not send it to the API.

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
      // Different models support different reasoning summarizers—for example, our computer use model supports the concise summarizer, while o4-mini supports detailed. To simply access the most detailed summarizer available, set the value of this parameter to auto and view the reasoning summary as part of the summary array in the reasoning output item.
      // This feature is also supported with streaming, and across the following reasoning models: o4-mini, o3, o3-mini and o1.
      const isGpt5 = this.config.name.startsWith('gpt5');
      const includeSummary =
        !isGpt5 || getConfig<boolean>('model.gpt5ReasoningSummary', false);
      params.reasoning = {};
      if (includeSummary) {
        params.reasoning.summary = 'auto'; // or "detailed"
      }
      if (this.capabilities.supportsReasoningEffort) {
        params.reasoning.effort = 'high'; // or "medium" or "low"
      }
      if (
        this.config.fullName.includes('o3') ||
        this.config.fullName.includes('o4')
      ) {
        // Stop sequences are unsupported for o3 and o4 reasoning models.
      }
    }

    // this.logger.debug(
    //   `CreateResponse params: ${JSON.stringify(params, null, 2)}`,
    // );

    if (useStreaming) {
      // this.logger.debug(
      //   `OpenAI Responses streaming params: ${JSON.stringify(params)}`,
      // );
      const stream = client.responses.stream(params, {
        signal,
      });
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

      // Note that there is no second consumption problem as per openai sdk examples
      const response = await stream.finalResponse();
      const finalReasoning = this.processThinkingBlock(response);
      thinking.finalize(finalReasoning ?? undefined);
      const [finalText] = this.extractResponse(response, '');
      if (output) output.finalize(finalText);
      // this.logger.debug(
      //   `OpenAI Responses final response: ${JSON.stringify(response)}`,
      // );
      this.previousResponseId = response.id;
      this.sentMessages = messages.length;
      return response;
    } else {
      const response = await client.responses.create(params, {
        signal,
      });
      this.previousResponseId = response.id;
      this.sentMessages = messages.length;
      return response;
    }
  }

  /**
   * Extract plain text and usage information from the Responses API result.
   *
   * The OpenAI Responses API returns a JSON structure like:
   * {
   *   "id": "resp_...",
   *   "object": "response",
   *   "status": "completed",
   *   "output": [
   *     {
   *       "id": "rs_...",
   *       "type": "reasoning",
   *       "summary": [
   *         { "type": "summary_text", "text": "..." },
   *         ...
   *       ]
   *     },
   *     {
   *       "id": "msg_...",
   *       "type": "message",
   *       "status": "completed",
   *       "content": [
   *         {
   *           "type": "output_text",
   *           "annotations": [],
   *           "text": "The actual response text goes here..."
   *         }
   *       ],
   *       "role": "assistant"
   *     }
   *   ],
   *   "usage": {
   *     "input_tokens": 123,
   *     "output_tokens": 123,
   *     "input_tokens_details": { "cached_tokens": 0 },
   *     "output_tokens_details": { "reasoning_tokens": 9920 },
   *     "total_tokens": 256
   *   }
   * }
   */
  extractResponse(
    responseObject: Response,
    endTag: string,
  ): [string, ResponseUsage | undefined, ProviderStopReason] {
    const usage = responseObject.usage || {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    };

    let newResponse = '';

    // Try direct output_text first (some response formats)
    if (responseObject.output_text) {
      newResponse = responseObject.output_text.trim();
    }
    // Handle the nested array structure from Responses API
    else if (Array.isArray(responseObject.output)) {
      // First, try to extract all "message" type parts and join their "content"
      const messageParts = responseObject.output.filter(
        (part): part is ResponseOutputMessage =>
          part.type === 'message' && 'content' in part,
      );
      if (messageParts.length > 0) {
        newResponse = messageParts
          .map((part) => {
            // If content is an array, flatten and extract output_text
            if (Array.isArray(part.content)) {
              return part.content
                .filter(
                  (c): c is ResponseOutputText =>
                    c.type === 'output_text' && 'text' in c,
                )
                .map((c) => c.text)
                .join('');
            } else if (typeof part.content === 'string') {
              return part.content;
            }
            return '';
          })
          .join('')
          .trim();
      } else {
        // Fallback: directly extract all output_text from output array (for older/alternate formats)
        newResponse = responseObject.output
          .filter((part) => 'text' in part && part.type !== 'reasoning')
          .map((part: any) => part.text)
          .join('')
          .trim();
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

  /** Price computation adapted for Responses API token fields. */
  computePrice(responseUsage: any): number {
    if (!responseUsage) {
      return 0.0;
    }

    // Response API uses input_tokens/output_tokens
    const promptTokens = responseUsage.input_tokens ?? 0;
    const completionTokens = responseUsage.output_tokens ?? 0;

    let basePrice = calculateTokenPrice(
      promptTokens,
      completionTokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );

    // Response API uses output_tokens_details and input_tokens_details
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
  computeResponseUsage(responseUsage: any, responseTime: number): any {
    if (!responseUsage) {
      const emptyUsage = {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      };
      const mapped = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      };
      return ResponseUsageFactory.fromOpenAIResponse(
        mapped,
        this.computePrice(emptyUsage),
        responseTime,
      );
    }

    const mapped = {
      prompt_tokens: responseUsage.input_tokens,
      completion_tokens: responseUsage.output_tokens,
      total_tokens: responseUsage.total_tokens,
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

  /**
   * Process reasoning summaries from the Responses API.
   * @param responseObject The API response object
   * @param groupId Optional group ID for logging
   * @param toolState Optional toolState to update with thinking blocks
   * @returns The concatenated reasoning summary or null
   */
  /**
   * Process reasoning summaries from the Responses API.
   * Handles a structure like:
   * {
   *   output: {
   *     [
   *       {
   *         id: "...",
   *         type: "reasoning",
   *         summary: [
   *           { type: "summary_text", text: "..." },
   *           ...
   *         ]
   *       },
   *       ...
   *     ]
   *   }
   * }
   * @param responseObject The API response object
   * @param groupId Optional group ID for logging
   * @param toolState Optional toolState to update with thinking blocks
   * @returns The concatenated reasoning summary or null
   */
  processThinkingBlock(
    responseObject: Response,
    groupId?: string,
    toolState?: ToolState,
  ): string | null {
    // Find the first output item with type === "reasoning"
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

    // Concatenate all 'text' fields from the summary array
    const thoughtContent = summaryParts
      .map((part: any) =>
        part.type === 'summary_text' && typeof part?.text === 'string'
          ? part.text
          : '',
      )
      .join('')
      .trim();

    // If toolState is provided and not already updated, add each summary part as a thinking block
    if (toolState && !toolState.thinkingAdded) {
      toolState.thinkingBlocks = summaryParts.map((part) => ({
        type: 'thinking',
        thinking: typeof part?.text === 'string' ? part.text : '',
      }));
      toolState.thinkingAdded = true;
    }

    // Log a preview of the reasoning content if available
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
    call: any,
    result: Record<string, unknown>,
    _toolState?: ToolState,
    text?: string,
  ): any[] {
    const messages: (ResponseInputItem | ChatCompletionMessageParam)[] = [];
    if (text) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
    }
    const callMsg: ResponseFunctionToolCall = {
      type: 'function_call',
      call_id: id,
      name,
      arguments:
        typeof call?.arguments === 'string'
          ? call.arguments
          : JSON.stringify(call?.input ?? call?.arguments ?? {}),
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
      role: 'user',
      content: [{ type: 'input_text', text: userMessage }],
    });
    return messages;
  }

  createAssistantMessage(text: string): ChatCompletionMessageParam {
    return { role: 'assistant', content: [{ type: 'text', text }] };
  }
}
