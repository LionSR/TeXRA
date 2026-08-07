// Local file imports
import { ChannelStreamAggregator } from '../utils/channelStreamAggregator';
import { extractTextFromReasoningDetails } from '../utils/openRouterReasoning';
import type {
  ChatAssistantMessage,
  ChatFinishReasonEnum,
  ChatRequestEffort,
  ChatResult,
  ChatStreamChunk,
  ChatToolCall,
  ChatUsage,
  ReasoningDetailUnion,
} from '@openrouter/sdk/models';

// OpenRouter reasoning tiers pass through when the selected model declares
// them. Unknown values fall back to 'low'.
const OPENROUTER_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'xhigh',
  'high',
  'medium',
  'low',
  'minimal',
  'none',
]);

export function toOpenRouterReasoningEffort(
  effort: string,
  supportsMax: boolean,
): ChatRequestEffort {
  if (effort === 'max') return supportsMax ? 'max' : 'xhigh';
  return OPENROUTER_REASONING_EFFORTS.has(effort)
    ? (effort as ChatRequestEffort)
    : 'low';
}

/**
 * Accumulates streaming chunks into a final ChatResult since the OpenRouter SDK
 * does not provide a `finalChatCompletion()` helper.
 */
export class OpenRouterStreamAggregator extends ChannelStreamAggregator {
  private reasoningDetails: ReasoningDetailUnion[] = [];
  private finishReason: ChatFinishReasonEnum | null = null;
  private usage: ChatUsage | null = null;
  private model = '';
  private id = '';
  private created = 0;

  consumeChunk(chunk: ChatStreamChunk): {
    contentDelta: string;
    reasoningDelta: string;
  } {
    if (!this.id && chunk.id) this.id = chunk.id;
    if (!this.model && chunk.model) this.model = chunk.model;
    if (!this.created && chunk.created) this.created = chunk.created;
    if (chunk.usage) this.usage = chunk.usage;

    // Surface streaming errors instead of silently ignoring them
    if (chunk.error) {
      throw new Error(
        `OpenRouter streaming error (${chunk.error.code}): ${chunk.error.message}`,
      );
    }

    const choice = chunk.choices[0];
    if (!choice) return { contentDelta: '', reasoningDelta: '' };

    if (choice.finishReason != null) {
      this.finishReason = choice.finishReason;
    }

    const delta = choice.delta;
    const contentDelta = delta.content ?? '';
    this.pushContent(contentDelta);

    // Reasoning - try reasoningDetails first, then reasoning string
    let reasoningDelta = '';
    if (delta.reasoningDetails?.length) {
      this.reasoningDetails.push(...delta.reasoningDetails);
      reasoningDelta = extractTextFromReasoningDetails(delta.reasoningDetails);
    } else if (delta.reasoning) {
      reasoningDelta = delta.reasoning;
    }
    this.pushReasoning(reasoningDelta);

    // Accumulate tool calls by index
    if (delta.toolCalls) {
      for (const tc of delta.toolCalls) {
        this.toolCalls.add({
          index: tc.index,
          id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments,
        });
      }
    }

    return { contentDelta, reasoningDelta };
  }

  buildResponse(): ChatResult {
    // Preserve the original OpenRouter materialization: emit every accumulated
    // entry with its raw id (no empty-dropping, no fallback id).
    const toolCalls: ChatToolCall[] = this.toolCalls.build(
      ({ id, name, arguments: args }) => ({
        id,
        type: 'function',
        function: { name, arguments: args },
      }),
      { dropEmpty: false, fallbackId: false },
    );

    const message: ChatAssistantMessage & { role: 'assistant' } = {
      role: 'assistant',
      content: this.getFullContent() || undefined,
    };
    if (toolCalls.length > 0) {
      message.toolCalls = toolCalls;
    }
    const reasoning = this.getFullReasoning();
    if (reasoning) {
      message.reasoning = reasoning;
    }
    if (this.reasoningDetails.length > 0) {
      message.reasoningDetails = this.reasoningDetails;
    }

    return {
      id: this.id,
      choices: [
        {
          index: 0,
          message,
          finishReason: this.finishReason,
        },
      ],
      created: this.created || Math.floor(Date.now() / 1000),
      model: this.model,
      object: 'chat.completion',
      systemFingerprint: null,
      usage: this.usage ?? undefined,
    };
  }
}
