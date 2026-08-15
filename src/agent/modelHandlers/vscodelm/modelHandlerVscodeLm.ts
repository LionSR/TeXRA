// Third-party imports
import { ModelProvider, type ModelConfig } from 'llm-zoo';

// Local imports
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  TokenCountOptions,
  VscodeLmToolCall,
} from '@agent/types/ModelHandlerContracts';
import { OPENAI_CHAT_FINISH } from '@agent/types/StopReasonTypes';
import type { MediaEntry } from '@agent/types/mediaTypes';
import { AgentError } from '@common/errors';
import type { SdkErrorKind } from '@common/errors/sdkError/sdkErrorKinds';
import { attachSdkErrorMetadata } from '@common/errors/sdkError/errorMetadata';
import {
  PARTIAL_TEXT_TAIL_MAX,
  takeTail,
} from '@common/errors/sdkError/errorPatterns';
import { handleStreamingFailure } from '@common/errors/sdkError/streamFailure';
import type { ResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import type { ToolDefinition } from '@model/ToolDefinition';
import { copilotRouteForModel } from '@model/runtimeModelRegistry';
import { platform } from '@platform/platform';
import {
  LANGUAGE_MODEL_PORT_ERROR_CODE,
  LanguageModelPortError,
  type LanguageModelDataPart,
  type LanguageModelMessage,
  type LanguageModelPort,
  type LanguageModelReference,
  type LanguageModelTextPart,
  type LanguageModelToolCallPart,
  type LanguageModelToolResultPart,
} from '@platform/languageModel';
import type {
  FileLocation,
  MediaAttachmentKind,
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas';
import { getMimeType } from '@utils/files/mimeUtils';

// Local file imports
import { ModelHandler } from '../ModelHandler';
import { toVscodeLmTools } from '../toolConversion';
import { formatToolResultTextWithAttachments } from '../utils/toolAttachmentUtils';

type VscodeLmUsage = undefined;

export interface VscodeLmResponse {
  readonly text: string;
  readonly toolCalls: readonly LanguageModelToolCallPart[];
  readonly usage: VscodeLmUsage;
  readonly stopReason:
    typeof OPENAI_CHAT_FINISH.STOP | typeof OPENAI_CHAT_FINISH.TOOL_CALLS;
}

const VISION_UNSUPPORTED_ERROR =
  'The selected VS Code language model does not support image input.';
const IMAGE_INPUT_ONLY_ERROR =
  'VS Code language models support image attachments in TeXRA, but audio and other native file inputs are not supported.';

function joinText(...sections: Array<string | undefined>): string {
  return sections
    .filter((section) => section !== undefined && section !== '')
    .join('\n\n');
}

function textPart(text: string): LanguageModelTextPart {
  return { kind: 'text', text };
}

function messageText(message: LanguageModelMessage): string {
  return message.content
    .filter((part): part is LanguageModelTextPart => part.kind === 'text')
    .map((part) => part.text)
    .join('');
}

function prependUserText(
  message: Extract<LanguageModelMessage, { role: 'user' }>,
  text: string,
): LanguageModelMessage {
  const [first, ...rest] = message.content;
  return {
    role: 'user',
    content:
      first?.kind === 'text'
        ? [textPart(joinText(text, first.text)), ...rest]
        : [textPart(text), ...message.content],
  };
}

function appendText(
  message: LanguageModelMessage,
  text: string,
): LanguageModelMessage {
  const content = [...message.content];
  const last = content.at(-1);
  if (last?.kind === 'text') {
    content[content.length - 1] = textPart(joinText(last.text, text));
  } else {
    content.push(textPart(text));
  }
  return { role: message.role, content } as LanguageModelMessage;
}

/** Fold a system prompt into the first user turn because VS Code has no system role. */
export function foldSystemPromptIntoVscodeLmMessages(
  messages: readonly LanguageModelMessage[],
  systemPrompt?: string,
): LanguageModelMessage[] {
  const copy = [...messages];
  if (!systemPrompt) return copy;

  const firstUserIndex = copy.findIndex((message) => message.role === 'user');
  if (firstUserIndex === -1) {
    return [{ role: 'user', content: [textPart(systemPrompt)] }, ...copy];
  }

  const firstUser = copy[firstUserIndex];
  if (firstUser.role !== 'user') return copy;
  copy[firstUserIndex] = prependUserText(firstUser, systemPrompt);
  return copy;
}

function sdkErrorKind(error: LanguageModelPortError): SdkErrorKind {
  switch (error.code) {
    case LANGUAGE_MODEL_PORT_ERROR_CODE.CANCELLED:
      return 'user_abort';
    case LANGUAGE_MODEL_PORT_ERROR_CODE.NO_PERMISSIONS:
      return 'permission_denied';
    case LANGUAGE_MODEL_PORT_ERROR_CODE.MODEL_UNAVAILABLE:
      return 'not_found';
    case LANGUAGE_MODEL_PORT_ERROR_CODE.QUOTA_EXCEEDED:
      return 'rate_limit';
    case LANGUAGE_MODEL_PORT_ERROR_CODE.HOST_UNAVAILABLE:
    case LANGUAGE_MODEL_PORT_ERROR_CODE.UNKNOWN:
      return 'api_error';
    default:
      error.code satisfies never;
      return 'api_error';
  }
}

function tagVscodeLmError(error: unknown, provider: string): void {
  if (!(error instanceof LanguageModelPortError)) return;
  attachSdkErrorMetadata(error, {
    provider,
    kind: sdkErrorKind(error),
    ...(error.code === LANGUAGE_MODEL_PORT_ERROR_CODE.QUOTA_EXCEEDED
      ? { exhaustionReason: 'copilot-subscription' as const }
      : {}),
  });
}

function requireSupportedMedia(
  mediaFiles: readonly FileLocation[] | undefined,
  supportsVision: boolean,
): void {
  if (!mediaFiles?.length) return;
  if (!supportsVision) throw new Error(VISION_UNSUPPORTED_ERROR);

  const unsupported = mediaFiles.find(({ absolutePath }) => {
    const mimeType = getMimeType(absolutePath);
    return mimeType !== 'application/pdf' && !mimeType?.startsWith('image/');
  });
  if (unsupported) throw new Error(IMAGE_INPUT_ONLY_ERROR);
}

function requireLanguageModelPort(): LanguageModelPort {
  const port = platform().languageModel;
  if (!port.isAvailable()) {
    throw new LanguageModelPortError(
      LANGUAGE_MODEL_PORT_ERROR_CODE.HOST_UNAVAILABLE,
      'The VS Code Language Model API is unavailable in this host. Copilot models require a compatible VS Code extension host.',
    );
  }
  return port;
}

/** Model handler for subscription-backed models exposed through `vscode.lm`. */
export class ModelHandlerVscodeLm extends ModelHandler<
  LanguageModelMessage,
  VscodeLmUsage,
  VscodeLmToolCall,
  LanguageModelPort,
  VscodeLmResponse,
  LanguageModelDataPart
> {
  constructor(
    config: ModelConfig,
    responseTextProcessing?: ResponseTextProcessing,
  ) {
    super(config, responseTextProcessing);
    this.capabilities.supportsNativeAudio = false;
    this.capabilities.supportsNativePdf = false;
    this.capabilities.supportsAssistantPrefill = false;
    this.capabilities.supportsTokenCounting = true;
  }

  override get requiresBatchedParallelToolResults(): boolean {
    return true;
  }

  protected override get sdkErrorTagger() {
    return tagVscodeLmError;
  }

  async getClient(): Promise<LanguageModelPort> {
    return requireLanguageModelPort();
  }

  /**
   * The exact editor model reference requests must use. Under canonical
   * model identity (#9635) the config belongs to the base model, so the
   * reference comes from the discovered Copilot route. The config-shaped
   * reference only serves the deprecated static Copilot-provider registry
   * entry; anything else means the route vanished between routing and
   * dispatch, and sending the base provider's vendor/id into the VS Code
   * language-model API would address a model it does not host.
   */
  private languageModelReference(): LanguageModelReference {
    const routeReference = copilotRouteForModel(this.config.name)?.reference;
    if (routeReference) return routeReference;
    if (this.config.provider === ModelProvider.COPILOT) {
      return { vendor: this.config.provider, id: this.config.fullName };
    }
    throw new AgentError(
      `Copilot access to "${this.config.name}" is no longer available. Refresh the model list or choose another access route.`,
    );
  }

  protected override async createResponseImpl(
    options: CreateResponseOptions<LanguageModelMessage, LanguageModelPort>,
  ): Promise<CreateResponseResult<VscodeLmResponse, LanguageModelMessage>> {
    const tools =
      this.capabilities.supportsFunctionCalling && options.tools?.length
        ? toVscodeLmTools(options.tools)
        : undefined;
    const signal = options.signal ?? new AbortController().signal;
    const model = this.languageModelReference();
    const output = this.createOutputStream();
    const text: string[] = [];
    const toolCalls: LanguageModelToolCallPart[] = [];

    try {
      for await (const part of options.client.sendRequest(
        model,
        options.messages,
        {
          justification: 'Run the selected TeXRA agent.',
          ...(tools ? { tools, toolMode: 'auto' as const } : {}),
        },
        signal,
      )) {
        if (part.kind === 'text') {
          text.push(part.text);
          output.append(part.text);
        } else {
          // VS Code emits each tool call as one complete part.
          toolCalls.push(part);
        }
      }

      if (signal.aborted) {
        throw new LanguageModelPortError(
          LANGUAGE_MODEL_PORT_ERROR_CODE.CANCELLED,
          `Language model "${this.config.fullName}" request was cancelled.`,
        );
      }

      const responseText = text.join('');
      output.finalize(responseText);
      return {
        response: {
          text: responseText,
          toolCalls,
          usage: undefined,
          stopReason:
            toolCalls.length > 0
              ? OPENAI_CHAT_FINISH.TOOL_CALLS
              : OPENAI_CHAT_FINISH.STOP,
        },
      };
    } catch (error) {
      return handleStreamingFailure(error, {
        finalizeOnError: () => output.finalize(),
        partialTail: () => takeTail(text.join(''), PARTIAL_TEXT_TAIL_MAX),
      });
    }
  }

  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: FileLocation[],
    systemPrompt?: string,
  ): Promise<LanguageModelMessage[]> {
    requireSupportedMedia(mediaFiles, this.capabilities.supportsVision);
    const media = mediaFiles?.length
      ? await this.createMediaForRound(mediaFiles, 'initial')
      : [];
    return foldSystemPromptIntoVscodeLmMessages(
      [
        {
          role: 'user',
          content: [textPart(joinText(userPrefix, userRequest)), ...media],
        },
      ],
      systemPrompt,
    );
  }

  async createRoundMessages(
    messages: LanguageModelMessage[],
    userMessage: string,
    mediaFiles?: FileLocation[],
  ): Promise<LanguageModelMessage[]> {
    requireSupportedMedia(mediaFiles, this.capabilities.supportsVision);
    const media = mediaFiles?.length
      ? await this.createMediaForRound(mediaFiles, 'followUp')
      : [];
    return [
      ...messages,
      { role: 'user', content: [textPart(userMessage), ...media] },
    ];
  }

  createMediaContent(mediaMessage: MediaEntry[]): LanguageModelDataPart[] {
    return mediaMessage.map((media) => {
      if (
        media.media_category !== 'image' ||
        !media.media_type.startsWith('image/')
      ) {
        throw new Error(IMAGE_INPUT_ONLY_ERROR);
      }
      if (!media.data) {
        throw new Error(`Missing image data for ${media.file_name}.`);
      }
      // Decoded here rather than alongside the base64 payload on the entry:
      // this is the only consumer of raw bytes, so keeping both forms on every
      // entry would double the memory held for media the other handlers send
      // as base64.
      return {
        kind: 'data' as const,
        data: Buffer.from(media.data, 'base64'),
        mimeType: media.media_type,
      };
    });
  }

  extractResponse(response: VscodeLmResponse): ExtractResponseResult {
    return {
      text: this.postProcessResponse(this.normalizeResponseText(response.text)),
      usage: response.usage,
      stopReason: response.stopReason,
    };
  }

  protected appendUserText(
    messages: LanguageModelMessage[],
    text: string,
  ): void {
    messages.push({ role: 'user', content: [textPart(text)] });
  }

  protected appendTextToLastAssistantMessage(
    messages: LanguageModelMessage[],
    text: string,
    options: { afterContinuationPrompt?: boolean } = {},
  ): boolean {
    let assistantIndex = messages.length - 1;
    const trailing = messages.at(-1);
    if (options.afterContinuationPrompt) {
      if (
        trailing?.role !== 'user' ||
        !messageText(trailing).includes('Your response got cut off')
      ) {
        return false;
      }
      assistantIndex -= 1;
    }

    const assistant = messages.at(assistantIndex);
    if (assistant?.role !== 'assistant') return false;
    messages[assistantIndex] = appendText(assistant, text);
    if (options.afterContinuationPrompt) messages.pop();
    return true;
  }

  computePrice(_responseUsage: VscodeLmUsage): number {
    return 0;
  }

  normalizeUsage(
    _rawUsage: VscodeLmUsage,
    _responseTimeMs: number,
  ): NormalizedUsage | undefined {
    return undefined;
  }

  processThinkingBlock(
    _response: VscodeLmResponse,
    _workspaceState?: AgentWorkspaceState,
  ): string | null {
    return null;
  }

  extractToolUse(response: VscodeLmResponse): VscodeLmToolCall[] {
    return response.toolCalls.map((call) => ({
      provider: 'vscode-lm',
      callId: call.callId,
      name: call.name,
      input: call.input,
      raw: call,
    }));
  }

  async createToolUseFollowUpMessages(
    _client: LanguageModelPort | undefined,
    call: VscodeLmToolCall,
    result: ToolResult,
    attachments: ToolFileAttachment[],
    _workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<LanguageModelMessage[]> {
    return this.buildToolUseFollowUpMessages(
      [{ call, result, attachments }],
      text,
    );
  }

  async createBatchedToolUseFollowUpMessages(
    entries: Array<{
      call: VscodeLmToolCall;
      result: ToolResult;
      attachments: ToolFileAttachment[];
    }>,
    _workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<LanguageModelMessage[]> {
    return this.buildToolUseFollowUpMessages(entries, text);
  }

  private buildToolUseFollowUpMessages(
    entries: Array<{
      call: VscodeLmToolCall;
      result: ToolResult;
      attachments: ToolFileAttachment[];
    }>,
    text?: string,
  ): LanguageModelMessage[] {
    if (entries.length === 0) return [];

    const assistantContent: Array<
      LanguageModelTextPart | LanguageModelToolCallPart
    > = [
      ...(text ? [textPart(text)] : []),
      ...entries.map(({ call }) => call.raw),
    ];
    const resultContent: LanguageModelToolResultPart[] = entries.map(
      ({ call, result, attachments }) => ({
        kind: 'toolResult',
        callId: call.callId,
        text: formatToolResultTextWithAttachments(result, attachments, true),
      }),
    );

    return [
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: resultContent },
    ];
  }

  async createUserFollowUpMessages(
    messages: LanguageModelMessage[],
    userMessage: string,
  ): Promise<LanguageModelMessage[]> {
    return [...messages, { role: 'user', content: [textPart(userMessage)] }];
  }

  createAssistantMessage(text: string): LanguageModelMessage {
    return { role: 'assistant', content: [textPart(text)] };
  }

  override extractAssistantText(
    message: LanguageModelMessage,
  ): string | undefined {
    return message.role === 'assistant' ? messageText(message) : undefined;
  }

  prependTextToUserMessage(
    messages: LanguageModelMessage[],
    text: string,
  ): void {
    if (!text.trim()) return;
    const index = messages.findLastIndex((message) => message.role === 'user');
    const message = messages[index];
    if (message?.role === 'user') {
      messages[index] = prependUserText(message, text);
    }
  }

  async addMediaToUserMessage(
    messages: LanguageModelMessage[],
    mediaFiles: FileLocation[],
  ): Promise<MediaAttachmentKind[]> {
    requireSupportedMedia(mediaFiles, this.capabilities.supportsVision);
    if (!mediaFiles.length) return [];

    const index = messages.findLastIndex((message) => message.role === 'user');
    const message = messages[index];
    if (message?.role !== 'user') return [];

    const media = await this.createMediaForRound(mediaFiles, 'insert');
    if (!media.length) return [];
    messages[index] = {
      role: 'user',
      content: [...message.content, ...media],
    };
    return this.consumeInsertedAttachmentKinds('insert');
  }

  override async estimateTokenCount(
    messages: LanguageModelMessage[],
    options?: TokenCountOptions<LanguageModelPort>,
  ): Promise<number> {
    const client = options?.client ?? (await this.getClient());
    const countableMessages = foldSystemPromptIntoVscodeLmMessages(
      messages,
      options?.systemPrompt,
    );
    const model = this.languageModelReference();

    try {
      const counts = await Promise.all([
        ...countableMessages.map((message) =>
          client.countTokens(model, message, options?.signal),
        ),
        ...(options?.tools?.length
          ? [
              client.countTokens(
                model,
                JSON.stringify(
                  toVscodeLmTools(options.tools as ToolDefinition[]),
                ),
                options.signal,
              ),
            ]
          : []),
      ]);
      return counts.reduce((total, count) => total + count, 0);
    } catch (error) {
      tagVscodeLmError(error, this.config.provider);
      throw error;
    }
  }
}
