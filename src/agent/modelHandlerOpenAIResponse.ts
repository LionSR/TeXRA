// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - base handler
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { ResponseUsageFactory } from './ResponseUsage';
import { calculateTokenPrice } from '../utils/priceUtils';

/**
 * Handler for OpenAI's new Responses API. Uses `previous_response_id` to
 * manage conversation state between calls.
 */
export class ModelHandlerOpenAIResponse extends ModelHandlerOpenAI {
  private previousResponseId: string | null = null;
  private sentMessages = 0;

  /** Reset conversation state when starting new messages. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: string[],
    systemPrompt?: string,
  ): Promise<any[]> {
    this.previousResponseId = null;
    this.sentMessages = 0;
    return super.initializeMessages(
      userPrefix,
      userRequest,
      mediaFiles,
      systemPrompt,
    );
  }

  /** Create a response using the Responses API. */
  async createResponse(
    client: OpenAI,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    signal?: AbortSignal,
  ): Promise<any> {
    const useStreaming = this.getStreamingConfig();

    const newMessages = messages.slice(this.sentMessages).map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const params: any = {
      model: this.config.fullName,
      input: newMessages,
      temperature,
      max_output_tokens: this.config.maxOutputTokens,
      store: true,
    };

    if (this.previousResponseId) {
      params.previous_response_id = this.previousResponseId;
    }
    if (systemPrompt) {
      params.instructions = systemPrompt;
    }

    if (this.capabilities.supportsReasoning) {
      // Different models support different reasoning summarizers—for example, our computer use model supports the concise summarizer, while o4-mini supports detailed. To simply access the most detailed summarizer available, set the value of this parameter to auto and view the reasoning summary as part of the summary array in the reasoning output item.
      // This feature is also supported with streaming, and across the following reasoning models: o4-mini, o3, o3-mini and o1.
      params.reasoning = {
        summary: 'auto', // or "detailed",
      };
      if (this.capabilities.supportsReasoningEffort) {
        params.reasoning.effort = 'high'; // or "medium" or "low"
      }
    }

    if (useStreaming) {
      params.stream = true;
      const stream = (await client.responses.create(params, {
        signal,
      })) as any;
      const response = await stream.finalResponse();
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

  /** Extract plain text and usage information from the Responses API result. */
  extractResponse(responseObject: any, endTag: string): [string, any, string] {
    const usage = responseObject.usage || {
      input_tokens: 0,
      output_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    };
    const newResponse = responseObject.output_text?.trim() || '';
    const stopReason =
      responseObject.status === 'completed' ? 'stop' : 'length';

    if (stopReason === 'stop' && endTag && !newResponse.includes(endTag)) {
      return [`${newResponse}\n${endTag}`, usage, stopReason];
    }
    return [newResponse, usage, stopReason];
  }

  /** Price computation adapted for Responses API token fields. */
  computePrice(responseUsage: any): number {
    if (!responseUsage) {
      return 0.0;
    }

    const promptTokens =
      responseUsage.prompt_tokens ?? responseUsage.input_tokens ?? 0;
    const completionTokens =
      responseUsage.completion_tokens ?? responseUsage.output_tokens ?? 0;

    let basePrice = calculateTokenPrice(
      promptTokens,
      completionTokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );

    const reasoningTokens =
      responseUsage.completion_tokens_details?.reasoning_tokens ??
      responseUsage.output_tokens_details?.reasoning_tokens ??
      0;
    const cachedTokens =
      responseUsage.prompt_tokens_details?.cached_tokens ??
      responseUsage.input_tokens_details?.cached_tokens ??
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
}
