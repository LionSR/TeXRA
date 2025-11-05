// Standard library imports
import { Buffer } from 'node:buffer';
import { basename } from 'node:path';

// Third-party imports
import { Anthropic, toFile } from '@anthropic-ai/sdk';
import type {
  BetaBase64ImageSource,
  BetaCacheControlEphemeral,
  BetaContextManagementConfig,
  BetaImageBlockParam,
  BetaMessage,
  BetaRequestDocumentBlock,
  BetaTextBlockParam,
  MessageCountTokensParams,
  MessageCreateParams,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages';
import type {
  MessageParam,
  ContentBlock,
  ContentBlockParam,
  ToolUseBlock,
  TextBlockParam,
  ImageBlockParam,
  DocumentBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta';

const isSupportedImageMediaType = (
  mediaType: string,
): mediaType is BetaBase64ImageSource['media_type'] => {
  switch (mediaType) {
    case 'image/jpeg':
    case 'image/png':
    case 'image/gif':
    case 'image/webp':
      return true;
    default:
      return false;
  }
};

interface UploadedAnthropicAttachment {
  attachment: ToolFileAttachment;
  fileId: string;
  blockType: 'image' | 'document';
  base64Data?: string;
  mediaType?: string;
}

// Local imports - agent
import { toAnthropicTools } from './toolConversion';
import type { ProviderStopReason } from './types/StopReasonTypes';
import type { ToolFileAttachment } from '@tools/result';
import { ANTHROPIC_STOP } from './types/StopReasonTypes';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentType,
  hasEndTag,
  requireWorkflowSetting,
} from '@agent/core/AgentDataclass';
import { ConversationRoundState } from '@agent/core/AgentState';
import {
  AnthropicAPIResponseUsage,
  ResponseUsageFactory,
  AnthropicUsage,
} from '@agent/core/ResponseUsage';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import { createContinuationMessage } from '@agent/utils/continuationMessage';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import {
  describeAttachments,
  extractToolAttachments,
  loadAttachmentBuffer,
} from './utils/toolAttachmentUtils';

// Local imports - error utils
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { ToolDefinition } from '@model';
import { cleanFileContent } from '@replacement/engine';
import replacementEngine from '@replacement/engine';
import { K_SLICE, getConfig } from '@utils/config';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import { objectToLogString } from '@utils/text/stringUtils';
import xmlUtils from '@utils/text/xmlUtils';

/**
 * Anthropic-specific model handler implementation for managing API interactions and message processing.
 */

const CONTEXT_1M_BETA: AnthropicBeta = 'context-1m-2025-08-07';
const FILES_API_BETA: AnthropicBeta = 'files-api-2025-04-14';
const SONNET_37_OUTPUT_BETA: AnthropicBeta = 'output-128k-2025-02-19';
const INTERLEAVED_THINKING_BETA: AnthropicBeta =
  'interleaved-thinking-2025-05-14';
const CONTEXT_MANAGEMENT_BETA: AnthropicBeta = 'context-management-2025-06-27';

const ANTHROPIC_1M_CONTEXT_WINDOW = 1_000_000;

type CacheControlEligibleBlock =
  | (ContentBlockParam & BetaTextBlockParam)
  | (ContentBlockParam & BetaToolResultBlockParam);

const EPHEMERAL_CACHE_CONTROL: BetaCacheControlEphemeral = {
  type: 'ephemeral',
};

const MAX_CACHE_CONTROLLED_BLOCKS = 4;

const isCacheControlEligibleBlock = (
  block: ContentBlockParam | ContentBlock | undefined,
): block is CacheControlEligibleBlock => {
  if (!block || typeof block !== 'object') {
    return false;
  }

  const blockType = (block as { type?: string }).type;
  return blockType === 'text' || blockType === 'tool_result';
};

export class ModelHandlerAnthropic extends ModelHandler<
  MessageParam,
  AnthropicUsage,
  AnthropicAPIResponseUsage,
  ToolUseBlock,
  Anthropic
> {
  private cacheControlledBlock?: CacheControlEligibleBlock;

  protected override get supportsToolFileOutputs(): boolean {
    return true;
  }

  protected override get supportsInlineToolImages(): boolean {
    return true;
  }

  private setCacheControlTarget(block: CacheControlEligibleBlock): void {
    if (!this.capabilities.supportsPromptCaching) {
      return;
    }

    if (this.cacheControlledBlock && this.cacheControlledBlock !== block) {
      delete this.cacheControlledBlock.cache_control;
    }

    block.cache_control = EPHEMERAL_CACHE_CONTROL;
    this.cacheControlledBlock = block;
  }

  private clearCacheControlTarget(): void {
    if (!this.capabilities.supportsPromptCaching) {
      this.cacheControlledBlock = undefined;
      return;
    }

    if (this.cacheControlledBlock) {
      delete this.cacheControlledBlock.cache_control;
    }
    this.cacheControlledBlock = undefined;
  }

  private getMutableBetas(options: MessageCreateParams): AnthropicBeta[] {
    if (!options.betas) {
      options.betas = [];
    }
    return options.betas;
  }

  private appendBeta(options: MessageCreateParams, beta: AnthropicBeta): void {
    const betas = this.getMutableBetas(options);
    if (!betas.includes(beta)) {
      betas.push(beta);
    }
  }

  private findCacheControlCandidate(
    content: (ContentBlockParam | ContentBlock)[] | undefined,
  ): CacheControlEligibleBlock | undefined {
    if (!Array.isArray(content) || content.length === 0) {
      return undefined;
    }

    for (let idx = content.length - 1; idx >= 0; idx -= 1) {
      const candidate = content[idx];
      if (isCacheControlEligibleBlock(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private assignCacheControlToLatest(
    content: (ContentBlockParam | ContentBlock)[] | undefined,
  ): void {
    if (!this.capabilities.supportsPromptCaching) {
      return;
    }

    const target = this.findCacheControlCandidate(content);
    if (target) {
      this.setCacheControlTarget(target);
    } else if (Array.isArray(content) && content.length > 0) {
      this.logger.debug(
        'No eligible content block available for Anthropic cache control marker',
      );
      this.clearCacheControlTarget();
    }
  }

  async getClient(): Promise<Anthropic> {
    const apiKey = await this.getApiKey();
    const baseUrl = this.getBaseUrl();
    // const baseUrl = 'https://api.anthropic.com/v1/';
    this.logger.debug(`Using Anthropic API. Base URL: ${baseUrl}`);
    // there is a time out parameter that be be set; default is 10 minutes
    return new Anthropic({ apiKey, baseURL: baseUrl });
  }

  /** Creates a chat completion response using Anthropic's API with specified parameters and optional system prompt. */
  async createResponse(
    client: Anthropic,
    messages: MessageParam[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): Promise<BetaMessage> {
    // Get streaming config
    const useStreaming = this.getStreamingConfig();
    const useAnthropic1MBeta = getConfig<boolean>(
      'texra.model.useAnthropic1MBeta',
      false,
    );
    const isAnthropic1MBetaEligibleModel =
      this.config.fullName === 'claude-sonnet-4-20250514' ||
      this.config.fullName === 'claude-sonnet-4-5';
    const isAnthropic1MBetaActive =
      useAnthropic1MBeta && isAnthropic1MBetaEligibleModel;
    const effectiveContextWindow = isAnthropic1MBetaActive
      ? ANTHROPIC_1M_CONTEXT_WINDOW
      : this.config.contextWindow;

    this.enforceCacheControlLimit(messages);

    const documentAnalysis = this.analyzeDocumentSources(messages);
    let hasFileReference = documentAnalysis.hasFileSource;

    // Prepare options for the API call
    const options: MessageCreateParams = {
      model: this.config.fullName,
      max_tokens: this.config.maxOutputTokens,
      messages,
      temperature,
      stop_sequences: endTag ? [endTag] : undefined,
      system: systemPrompt,
    };

    if (tools && tools.length > 0) {
      options.tools = toAnthropicTools(tools);
      (options as MessageCreateParams).tool_choice = { type: 'auto' };

      if (this.config.capabilities.supportsInterleavedThinking) {
        this.appendBeta(options, INTERLEAVED_THINKING_BETA);
      }
    }

    // Enable thinking for any models that support reasoning
    if (this.capabilities.supportsReasoning) {
      // This ensures thinking is explicitly enabled for all models that support it
      this.logger.debug('Enabling thinking for model with reasoning support');

      // Calculate thinking budget based on max_tokens constraint
      // budget_tokens must be less than max_tokens
      const maxBudget = Math.floor(this.config.maxOutputTokens * 0.5); // Use 50% of max_tokens as safe budget
      const defaultBudget = useStreaming ? 32768 : 4096; // this logics only applies to sonnet 3.7
      const thinkingBudget = Math.min(defaultBudget, maxBudget);

      options.thinking = {
        type: 'enabled',
        budget_tokens: thinkingBudget,
      };

      this.logger.debug(
        `Set thinking budget: ${thinkingBudget} tokens (max_tokens: ${this.config.maxOutputTokens}, streaming: ${useStreaming})`,
      );

      // Remove temperature for Claude 4 models when thinking is enabled as per Anthropic docs
      if (
        this.config.fullName.includes('claude-opus-4') ||
        this.config.fullName.includes('claude-sonnet-4-5') ||
        this.config.fullName.includes('claude-sonnet-4') ||
        this.config.fullName.includes('claude-haiku-4-5') ||
        this.config.fullName.includes('claude-3-7-sonnet')
      ) {
        delete options.temperature;
      }
    }

    // Add beta features for Claude 3.7 Sonnet to increase max output to 128k tokens and enable thinking
    if (this.config.fullName === 'claude-3-7-sonnet-20250219') {
      // useStreaming = true; should consider to be true by default
      // temperature already deleted above for reasoning models

      const sonnetBetas = this.getMutableBetas(options);
      sonnetBetas.length = 0;
      sonnetBetas.push(SONNET_37_OUTPUT_BETA);
      // Update max tokens to use the higher limit when streaming
      options.max_tokens = useStreaming ? 64000 : this.config.maxOutputTokens;
      // The thinking configuration is now handled above for all reasoning models
    }

    // Opt-in beta for 1M context window on Claude Sonnet 4 family
    if (isAnthropic1MBetaActive) {
      this.appendBeta(options, CONTEXT_1M_BETA);
    }

    if (this.capabilities.supportsTokenCounting) {
      if (documentAnalysis.hasFileSource) {
        this.logger.debug(
          'Skipping token counting because Anthropic countTokens does not support file-based document sources.',
        );
      } else {
        const countTokensParams: MessageCountTokensParams = {
          model: this.config.fullName,
          system: systemPrompt,
          messages,
        };

        // If thinking is enabled, we need to pass it to countTokens as well
        // to ensure consistency with the actual message creation.
        // Without this, the API returns an error when messages contain thinking blocks.
        if (options.thinking) {
          countTokensParams.thinking = options.thinking;
        }

        // Strip betas that only apply to message creation (e.g., output length)
        // while keeping context headers needed for accurate token counting.
        const countTokenBetas = options.betas?.filter(
          (beta) => beta === CONTEXT_1M_BETA,
        );
        if (countTokenBetas && countTokenBetas.length > 0) {
          countTokensParams.betas = countTokenBetas;
        }

        const responseTokenCount =
          await client.beta.messages.countTokens(countTokensParams);
        const { input_tokens: inputTokens } = responseTokenCount;
        this.logger.debug(`Token count of message: ${inputTokens}`);
        if (inputTokens > effectiveContextWindow) {
          const errMsg = `Token count of message exceeds context window: ${inputTokens} > ${effectiveContextWindow}`;
          this.logger.error(errMsg);
          throw new Error(errMsg);
        }
        if (effectiveContextWindow - inputTokens < options.max_tokens) {
          const reducedMaxTokens = Math.max(
            0,
            effectiveContextWindow - inputTokens - 10,
          );
          const warnMsg = `Token count of message plus max tokens exceeds context window: ${inputTokens} + ${options.max_tokens} > ${effectiveContextWindow}. Reducing max tokens to ${reducedMaxTokens}.`;
          this.logger.warn(warnMsg);
          options.max_tokens = reducedMaxTokens;

          if (
            this.capabilities.supportsReasoning &&
            options.thinking &&
            options.thinking.type === 'enabled'
          ) {
            const adjustedBudget = Math.max(
              1,
              Math.min(
                options.thinking.budget_tokens,
                Math.floor(options.max_tokens * 0.5),
              ),
            );
            if (adjustedBudget !== options.thinking.budget_tokens) {
              this.logger.debug(
                `Adjusted thinking budget to ${adjustedBudget} due to reduced max_tokens`,
              );
              options.thinking.budget_tokens = adjustedBudget;
            }
          }
        }
        // in the future we log this in firstInputTokens of the AgentRunState
      }
    }

    if (documentAnalysis.hasBase64Pdf) {
      const uploadResult = await this.replaceDocumentDataWithUploads(
        client,
        messages,
      );
      if (uploadResult.hasFileReference) {
        hasFileReference = true;
      }
    }

    if (hasFileReference) {
      this.appendBeta(options, FILES_API_BETA);
    }

    if (this.agentType === AgentType.ToolUse) {
      this.appendBeta(options, CONTEXT_MANAGEMENT_BETA);

      const contextManagementEdits = [
        ...(options.context_management?.edits ?? []),
      ];

      if (
        !contextManagementEdits.some(
          (edit) => edit.type === 'clear_tool_uses_20250919',
        )
      ) {
        contextManagementEdits.push({ type: 'clear_tool_uses_20250919' });
      }

      options.context_management = {
        ...(options.context_management ?? {}),
        edits: contextManagementEdits,
      } satisfies BetaContextManagementConfig;
    }

    // this.logger.debug(
    //   `CreateResponse options: ${JSON.stringify(options, null, 2)}`,
    // );

    let response: BetaMessage;

    try {
      if (useStreaming) {
        // in the future if we pass stream to outside, calling stream.controller.abort() will abort the stream; which will be very useful for our stop button
        // we should also make sure partial results can be returned in the presence of errors!
        const stream = client.beta.messages.stream(options, { signal });

        if (signal?.aborted) {
          stream.controller.abort();
          const abortError =
            signal.reason ??
            Object.assign(new Error('The operation was aborted.'), {
              name: 'AbortError',
            });
          throw abortError;
        }

        let cleanupAbortListener: (() => void) | undefined;
        if (signal) {
          const abortListener = () => {
            stream.controller.abort();
            signal.removeEventListener('abort', abortListener);
          };
          signal.addEventListener('abort', abortListener);
          cleanupAbortListener = () => {
            signal.removeEventListener('abort', abortListener);
          };
        }

        try {
          const thinking = this.createThinkingStream();
          const output = this.isOutputStreamingEnabled()
            ? this.createOutputStream()
            : undefined;
          stream.on('thinking', (delta: string) => {
            thinking.append(delta);
          });
          stream.on('text', (delta: string) => {
            output?.append(delta);
          });

          // Note that there is no second consumption problem as per anthropic sdk examples
          response = await stream.finalMessage();
          const finalReasoning = this.processThinkingBlock(response);
          thinking.finalize(finalReasoning ?? undefined);
          const finalOutput =
            response.content
              ?.filter((c: any) => c.type === 'text')
              ?.map((c: any) => c.text)
              .join('') ?? '';
          if (output) output.finalize(finalOutput);
        } finally {
          cleanupAbortListener?.();
        }
      } else {
        response = await client.beta.messages.create(options, { signal });
      }
    } catch (err) {
      this.logger.error(
        `Error creating response: ${getSdkErrorMessage(err)}`,
        undefined,
        undefined,
        err,
      );
      throw err;
    }

    return response;
  }

  private enforceCacheControlLimit(messages: MessageParam[]): void {
    if (!this.capabilities.supportsPromptCaching) {
      return;
    }

    const cacheControlledBlocks: CacheControlEligibleBlock[] = [];

    for (const message of messages) {
      const content = message.content;
      if (!Array.isArray(content) || content.length === 0) {
        continue;
      }

      for (const block of content) {
        if (!isCacheControlEligibleBlock(block)) {
          if (
            block &&
            typeof block === 'object' &&
            'cache_control' in block &&
            (block as { cache_control?: unknown }).cache_control
          ) {
            delete (block as { cache_control?: unknown }).cache_control;
          }
          continue;
        }

        if (block.cache_control) {
          cacheControlledBlocks.push(block);
        }
      }
    }

    if (cacheControlledBlocks.length <= MAX_CACHE_CONTROLLED_BLOCKS) {
      this.cacheControlledBlock = cacheControlledBlocks.at(-1);
      return;
    }

    const excess = cacheControlledBlocks.length - MAX_CACHE_CONTROLLED_BLOCKS;
    for (let idx = 0; idx < excess; idx += 1) {
      const block = cacheControlledBlocks[idx];
      delete block.cache_control;
    }

    const remainingBlocks = cacheControlledBlocks.slice(excess);
    this.cacheControlledBlock = remainingBlocks.at(-1);
  }

  private async replaceDocumentDataWithUploads(
    client: Anthropic,
    messages: MessageParam[],
  ): Promise<{ uploaded: boolean; hasFileReference: boolean }> {
    if (!this.capabilities.supportsNativePdf) {
      return { uploaded: false, hasFileReference: false };
    }

    let uploaded = false;
    let hasFileReference = false;

    for (const message of messages) {
      const contentBlocks = message.content;
      if (!Array.isArray(contentBlocks)) {
        continue;
      }

      for (const block of contentBlocks) {
        if (block.type !== 'document') {
          continue;
        }

        const source = block.source;
        if (!source) {
          continue;
        }

        if ('file_id' in (source as { file_id?: string })) {
          hasFileReference = true;
          continue;
        }

        if (source.type !== 'base64') {
          continue;
        }

        const mediaType = source.media_type;
        if (mediaType !== 'application/pdf') {
          continue;
        }

        const base64Data = source.data;
        if (!base64Data) {
          continue;
        }

        const filename =
          (block.title ?? 'document.pdf').trim() || 'document.pdf';
        const sanitizedFilename = this.sanitizeFilename(filename);
        let buffer: Buffer | undefined;
        let uploadedSource: BetaRequestDocumentBlock['source'] | undefined;

        try {
          buffer = Buffer.from(base64Data, 'base64');
          const uploadedFile = await client.beta.files.upload({
            file: await toFile(buffer, sanitizedFilename, { type: mediaType }),
            betas: [FILES_API_BETA],
          });

          uploadedSource = {
            type: 'file',
            file_id: uploadedFile.id,
          } as BetaRequestDocumentBlock['source'];
        } catch (err) {
          this.logger.error(
            `Failed to upload document ${filename}: ${getSdkErrorMessage(err)}`,
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

        if (uploadedSource) {
          delete (source as { data?: string }).data;
          (block as BetaRequestDocumentBlock).source = uploadedSource;
          uploaded = true;
          hasFileReference = true;
        }
      }
    }

    return { uploaded, hasFileReference };
  }

  private analyzeDocumentSources(messages: MessageParam[]): {
    hasFileSource: boolean;
    hasBase64Pdf: boolean;
  } {
    let hasFileSource = false;
    let hasBase64Pdf = false;

    for (const message of messages) {
      const contentBlocks = message.content;
      if (!Array.isArray(contentBlocks)) {
        continue;
      }

      for (const block of contentBlocks) {
        if (block.type !== 'document') {
          continue;
        }

        const source = block.source;
        if (!source) {
          continue;
        }

        if ('file_id' in (source as { file_id?: string })) {
          hasFileSource = true;
        } else if (source.type === 'base64') {
          if (source.media_type === 'application/pdf' && source.data) {
            hasBase64Pdf = true;
          }
        }

        if (hasFileSource && hasBase64Pdf) {
          return { hasFileSource: true, hasBase64Pdf: true };
        }
      }
    }

    return { hasFileSource, hasBase64Pdf };
  }

  private async uploadToolAttachments(
    client: Anthropic,
    attachments: ToolFileAttachment[],
  ): Promise<{
    uploaded: UploadedAnthropicAttachment[];
    unsupported: ToolFileAttachment[];
  }> {
    const uploaded: UploadedAnthropicAttachment[] = [];
    const unsupported: ToolFileAttachment[] = [];

    for (const attachment of attachments) {
      const mimeType = attachment.mimeType ?? 'application/octet-stream';
      const normalized = mimeType.toLowerCase();
      const isImage = isSupportedImageMediaType(normalized);
      const isPdf = normalized === 'application/pdf';

      if (!isImage && !isPdf) {
        unsupported.push(attachment);
        continue;
      }

      let buffer: Buffer | undefined;
      try {
        buffer = await loadAttachmentBuffer(attachment);
      } catch (err) {
        this.logger.warn(
          `Unable to read attachment ${attachment.path ?? 'attachment'}: ${getSdkErrorMessage(err)}`,
        );
        unsupported.push(attachment);
        continue;
      }

      try {
        const filename = this.sanitizeFilename(
          attachment.path ??
            (isPdf
              ? 'document.pdf'
              : `image.${normalized.split('/').pop() ?? 'png'}`),
        );

        const base64Data = buffer.toString('base64');
        const uploadedFile = await client.beta.files.upload({
          file: await toFile(buffer, filename, { type: mimeType }),
          betas: [FILES_API_BETA],
        });

        uploaded.push({
          attachment,
          fileId: uploadedFile.id,
          blockType: isPdf ? 'document' : 'image',
          base64Data,
          mediaType: normalized,
        });
      } catch (err) {
        this.logger.error(
          `Failed to upload attachment ${attachment.path ?? 'attachment'}: ${getSdkErrorMessage(err)}`,
          undefined,
          undefined,
          err,
        );
        unsupported.push(attachment);
      } finally {
        if (buffer) {
          buffer.fill(0);
          buffer = undefined;
        }
      }
    }

    return { uploaded, unsupported };
  }

  private sanitizeFilename(filename: string): string {
    const baseName = basename(filename) || filename;
    const trimmed = baseName.trim();
    const withoutControlChars = Array.from(trimmed, (char) =>
      char.charCodeAt(0) < 32 ? '_' : char,
    ).join('');
    const withoutForbidden = withoutControlChars.replace(/[:<>"|?*\\/]/g, '_');
    const sanitized = withoutForbidden || 'document.pdf';
    // Removing directory information avoids Anthropic rejecting names that contain
    // slashes, but it also means the model loses subdirectory context when
    // generating citations for assets or pictures that originally lived in nested
    // folders.
    return sanitized.slice(0, 255);
  }

  /** Initializes the message array for Anthropic chat models with user prefix, request, and optional media. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: string[],
    systemPrompt?: string,
  ): Promise<MessageParam[]> {
    const trimmedPrefix = userPrefix.trim();
    const trimmedRequest = userRequest.trim();

    if (!trimmedPrefix && !trimmedRequest) {
      const errMsg =
        'Anthropic messages require a non-empty user prefix or request.';
      this.logger.error(errMsg);
      throw new Error(errMsg);
    }

    this.clearCacheControlTarget();

    // Create content list for the user message
    const userMessageContent: ContentBlockParam[] = [];

    if (trimmedPrefix) {
      userMessageContent.push({
        type: 'text',
        text: trimmedPrefix,
        citations: null,
      });
    }

    // Add media if provided (images and native PDFs)
    if (mediaFiles && this.config.capabilities.supportsVision) {
      const formattedMediaContent = await this.createMediaMessage(mediaFiles);
      userMessageContent.push(...formattedMediaContent);
    }

    // Add user request with optional caching
    if (trimmedRequest) {
      const requestBlock: ContentBlockParam = {
        type: 'text',
        text: trimmedRequest,
        citations: null,
      };
      userMessageContent.push(requestBlock);
    }

    // Note: Anthropic handles system prompts differently via createResponse()
    const messages: MessageParam[] = [
      { role: 'user', content: userMessageContent },
    ];

    this.assignCacheControlToLatest(userMessageContent);

    return messages;
  }

  /** Creates message array for subsequent rounds, managing cache control and image content. */
  async createRoundMessages(
    messages: MessageParam[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<MessageParam[]> {
    // Create content list for the new round message
    const roundContent: ContentBlockParam[] = [];

    // Add media if provided (images and native PDFs)
    if (
      mediaFiles &&
      mediaFiles.length > 0 &&
      this.config.capabilities.supportsVision
    ) {
      try {
        const formattedMediaContent = await this.createMediaMessage(mediaFiles);
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

    // Add message text with optional caching
    const trimmedMessage = userMessage.trim();
    if (trimmedMessage) {
      const messageBlock: ContentBlockParam = {
        type: 'text',
        text: trimmedMessage,
        citations: null,
      };
      roundContent.push(messageBlock);
    }

    if (roundContent.length === 0) {
      const errMsg =
        'Anthropic follow-up messages require at least one non-empty content block.';
      this.logger.error(errMsg);
      throw new Error(errMsg);
    }

    messages.push({ role: 'user', content: roundContent });

    this.assignCacheControlToLatest(roundContent);

    return messages;
  }

  async createUserFollowUpMessages(
    messages: MessageParam[],
    userMessage: string,
  ): Promise<MessageParam[]> {
    const trimmedMessage = userMessage.trim();
    if (!trimmedMessage) {
      const errMsg =
        'Anthropic follow-up messages require non-empty user text.';
      this.logger.error(errMsg);
      throw new Error(errMsg);
    }
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: trimmedMessage, citations: null }],
    });

    const lastMessage = messages.at(-1);
    if (lastMessage && Array.isArray(lastMessage.content)) {
      this.assignCacheControlToLatest(lastMessage.content);
    }

    return messages;
  }

  createAssistantMessage(text: string): MessageParam {
    return {
      role: 'assistant',
      content: [{ type: 'text', text, citations: null }],
    };
  }

  /** Converts image/document content array into Anthropic-compatible message format with type and source metadata. */
  createMediaContent(mediaMessage: MediaEntry[]): ContentBlockParam[] {
    if (mediaMessage.length === 0) {
      return [];
    }
    this.logger.debug(
      `Creating media content for ${mediaMessage.length} items for Anthropic`,
    );
    return mediaMessage.flatMap((media): ContentBlockParam[] => {
      if (media.media_category === 'image') {
        // for backward compatibility
        // Always ensure media_type exists
        const originalMediaType = media.media_type;
        let resolvedMediaType = originalMediaType;
        if (!resolvedMediaType) {
          // Default to image/png since PDFs from TikZ are converted to PNG
          this.logger.warn(
            `No media_type found for image ${media.file_name}, defaulting to image/png`,
          );
          resolvedMediaType = 'image/png';
        }

        // Check for native PDF support
        const isPdf =
          this.capabilities.supportsNativePdf &&
          originalMediaType === 'application/pdf';
        const descriptionBlock = {
          type: 'text',
          text: `${isPdf ? 'Document' : 'Image'}: ${media.file_name}`,
          citations: null,
        } satisfies BetaTextBlockParam;

        if (isPdf) {
          const documentBlock = {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: media.data,
            },
            title: media.file_name,
          } satisfies BetaRequestDocumentBlock;
          return [descriptionBlock, documentBlock];
        }

        let imageMediaType: BetaBase64ImageSource['media_type'];
        if (isSupportedImageMediaType(resolvedMediaType)) {
          imageMediaType = resolvedMediaType;
        } else {
          if (resolvedMediaType && resolvedMediaType !== 'image/png') {
            this.logger.warn(
              `Unsupported image media type ${resolvedMediaType} for ${media.file_name}, defaulting to image/png`,
            );
          }
          imageMediaType = 'image/png';
        }

        const imageBlock = {
          type: 'image',
          source: {
            type: 'base64',
            media_type: imageMediaType,
            data: media.data,
          },
        } satisfies BetaImageBlockParam;

        return [descriptionBlock, imageBlock];
      } else if (media.media_category === 'audio') {
        // Anthropic doesn't explicitly support native audio input yet
        this.logger.warn(
          `Audio input received (${media.file_name}) but native audio is not currently supported by the Anthropic handler. Skipping.`,
        );
        return []; // Return empty array to skip audio
      } else {
        this.logger.warn(
          `Unknown media category for Anthropic: ${media.media_category}`,
        );
        return [];
      }
    });
  }

  /** Processes Anthropic API response, handling errors, and formatting while returning [response, usage, stopReason]. */
  extractResponse(
    responseObject: BetaMessage,
    endTag: string,
  ): [string, AnthropicUsage, ProviderStopReason] {
    // Check for empty response
    if (responseObject.usage.output_tokens === 3) {
      // Anthropic specific empty response check
      const errorMsg = 'No output generated - API returned empty response';
      this.logger.error(errorMsg);
      this.logger.debug(`responseObject: ${objectToLogString(responseObject)}`);
      this.logger.debug(
        `responseObject.content: ${objectToLogString(responseObject.content)}`,
      );
      throw new Error(errorMsg);
    }

    // Extract base response
    const stopReason = responseObject.stop_reason;
    let newResponse = '';

    if (
      this.capabilities.supportsReasoning &&
      Array.isArray(responseObject.content) &&
      responseObject.content.length > 0
    ) {
      // Handle text blocks in Claude 3.7 Sonnet responses
      for (const block of responseObject.content) {
        if (block.type === 'text') {
          newResponse += block.text.trim();
        }
        // We don't include thinking blocks in the response text
      }
    } else if (responseObject.content && responseObject.content.length > 0) {
      // Handle regular text responses
      const firstBlock = responseObject.content[0];
      if (firstBlock.type === 'text') {
        newResponse = firstBlock.text.trim();
      }
    }

    // Add end tag if needed
    if (
      stopReason === ANTHROPIC_STOP.STOP_SEQUENCE &&
      !newResponse.includes(endTag)
    ) {
      newResponse += `\n${endTag}`;
    }

    newResponse = replacementEngine.applyAll(newResponse);

    return [newResponse, responseObject.usage, stopReason || 'stop'];
  }

  /** Manages continuation with prefill support (typically no-op for models with prefill). */
  addContinueMessageWithPrefill(
    _messages: MessageParam[],
    _stateRound: ConversationRoundState,
    _toolState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    this.logger.debug('Skipping continuation - assistant prefill is supported');
    // No-op for models that support prefill
  }

  /** Manages continuation for models without prefill support by adding a continuation prompt. */
  addContinueMessageWithoutPrefill(
    messages: MessageParam[],
    _stateRound: ConversationRoundState,
    toolState: AgentWorkspaceState,
    agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    // Create continuation message with last K tokens
    const prefillTokens = toolState.assembly.lastResponse.slice(-K_SLICE);
    const userMessageContinuation = createContinuationMessage(
      agentSetting.endTag,
      prefillTokens,
    );

    // Add continuation message
    this.logger.debug(
      `Adding continuation message to conversation. Continuation message:\n ${userMessageContinuation}`,
    );
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: userMessageContinuation }],
    });

    const lastMessage = messages.at(-1);
    if (lastMessage && Array.isArray(lastMessage.content)) {
      this.assignCacheControlToLatest(lastMessage.content);
    }
  }

  /** Initializes output file and handles prefill content, returning [isComplete, updatedMessages]. */
  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: MessageParam[],
    toolState: AgentWorkspaceState,
    outputFile: string,
    prefill: string,
  ): Promise<[boolean, MessageParam[]]> {
    const workflowSetting = requireWorkflowSetting(agentSetting);
    let endTurn = false;

    if (!(await WorkspaceFS.existsAndNonTrivial(outputFile))) {
      if (this.capabilities.supportsAssistantPrefill) {
        this.logger.debug(`Adding prefill message:\n${prefill}`);
        if (
          toolState.assembly.accumulatedOutput.includes('<scratchpad>') &&
          prefill === '<scratchpad>' // this is not so neat
        ) {
          await WorkspaceFS.write(outputFile, prefill);
        } else if (workflowSetting.outputExt === 'xml') {
          await WorkspaceFS.write(outputFile, prefill + '\n');
        }
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: prefill }],
        });
      } else {
        // For thinking-enabled models that don't support assistant prefill,
        // add prefill as part of the user message like OpenAI handler

        const PseudoPrefillMsgContentString = `Start your response with:\n${prefill}`;
        const lastMsg = messages.at(-1);
        if (lastMsg && Array.isArray(lastMsg.content)) {
          lastMsg.content.push({
            type: 'text',
            text: PseudoPrefillMsgContentString,
          } as ContentBlockParam);
        }
        this.logger.debug(
          `Added pseudo prefill message to messages:\n${PseudoPrefillMsgContentString}`,
        );
      }
      return [endTurn, messages];
    }

    // Get prefill from existing and non-trivial file
    let fileContent = await WorkspaceFS.read(outputFile);
    fileContent = cleanFileContent(fileContent);

    // Extract any existing scratchpad content
    const scratchpad = await xmlUtils.extractScratchpad(
      fileContent,
      'scratchpad',
    );
    if (scratchpad) {
      this.logger.info(scratchpad, undefined, MESSAGE_TYPES.SCRATCHPAD);
    }

    await WorkspaceFS.write(outputFile, fileContent);

    // Update the toolState with the actual file content
    toolState.assembly.updateAccumulatedOutput(fileContent);
    toolState.assembly.updateLastResponse(fileContent);

    const lastMessage = messages.at(-1);
    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug('End tag detected - skipping continuation');
      // this is suspicious, because the two conflicts!!! we should check
      if (lastMessage && Array.isArray(lastMessage.content)) {
        const lastContent = lastMessage.content[lastMessage.content.length - 1];
        if (lastContent && lastContent.type === 'text') {
          lastContent.text = fileContent;
        }
      } else if (lastMessage) {
        lastMessage.content = [
          {
            type: 'text',
            text: fileContent,
          } as ContentBlockParam,
        ];
      }

      this.clearCacheControlTarget();

      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.warn(
      'Output file exists but no end tag found - continuing from file',
    );

    // For thinking-enabled models that don't support assistant prefill,
    // add continuation as part of the user message

    const content: ContentBlockParam[] = [
      {
        type: 'text' as const,
        text: fileContent,
      },
    ];
    this.logger.debug(`Using existing content as prefill: ${outputFile}`);
    messages.push({ role: 'assistant', content });

    this.assignCacheControlToLatest(content);

    if (!this.capabilities.supportsAssistantPrefill) {
      // For models that don't support assistant prefill, we need to:
      // add a continuation message in addition
      const state = new ConversationRoundState(0);
      this.addContinueMessageWithoutPrefill(
        messages,
        state,
        toolState,
        agentSetting,
        agentConfig,
      );

      this.logger.debug(
        `Added existing content as assistant message and continuation prompt`,
      );
    }

    endTurn = false;
    return [endTurn, messages];
  }

  /** Calculates API usage cost based on input/output tokens and cache usage if supported. */
  computePrice(responseUsage: AnthropicUsage): number {
    if (!responseUsage) {
      return 0;
    }

    // Note: Anthropic doesn't provide tool_use_tokens in their API response

    let basePrice = calculateTokenPrice(
      responseUsage.input_tokens,
      responseUsage.output_tokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );

    if (this.capabilities.supportsPromptCaching) {
      if (
        'cache_creation_input_tokens' in responseUsage &&
        responseUsage.cache_creation_input_tokens !== null
      ) {
        basePrice +=
          (responseUsage.cache_creation_input_tokens *
            this.config.inputPrice *
            1.25) /
          1e6;
      }
      if (
        'cache_read_input_tokens' in responseUsage &&
        responseUsage.cache_read_input_tokens !== null
      ) {
        basePrice +=
          (responseUsage.cache_read_input_tokens *
            this.config.inputPrice *
            this.capabilities.cacheDiscountFactor) /
          1e6;
      }
    }

    return basePrice;
  }

  /** Computes detailed response usage metrics including tokens, price, and response time. */
  computeResponseUsage(
    responseUsage: AnthropicUsage,
    responseTime: number,
  ): AnthropicAPIResponseUsage {
    return ResponseUsageFactory.fromAnthropicResponse(
      responseUsage,
      this.computePrice(responseUsage),
      responseTime,
    );
  }

  updateMessageContentWithPrefill(
    messages: MessageParam[],
    bestConnector: string,
    newResponse: string,
    toolState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);

    if (lastMessage && lastMessage.role === 'assistant') {
      if (Array.isArray(lastMessage.content)) {
        const newMessage: ContentBlockParam = {
          type: 'text',
          text: bestConnector + newResponse,
        };
        lastMessage.content.push(newMessage);
      } else {
        lastMessage.content = [
          {
            type: 'text',
            text: toolState.assembly.accumulatedOutput,
          } as ContentBlockParam,
        ];
      }

      if (Array.isArray(lastMessage.content)) {
        this.assignCacheControlToLatest(lastMessage.content);
      }
    }
    return;
  }

  updateMessageContentWithoutPrefill(
    messages: MessageParam[],
    bestConnector: string,
    newResponse: string,
    toolState: AgentWorkspaceState,
  ): void {
    // For thinking-enabled anthropic models that don't support assistant prefill,
    // handle like OpenAI models where the last message is always a user message
    const lastMessage = messages.at(-1);
    const secondLastMessage = messages.at(-2);

    if (!lastMessage || lastMessage.role !== 'user') {
      this.logger.error(
        'Last message is not a user message - unexpected format',
      );
      return;
    }
    this.logger.debug('Last message is a user message');

    // Fix for continuation issues
    if (lastMessage && this.containCutOffMessage(lastMessage.content)) {
      this.logger.debug(
        'Last message is a user message asking to continue after cutoff',
      );

      // The last message is a user message
      // So the second last message must be an assistant message

      if (secondLastMessage && secondLastMessage.role === 'assistant') {
        // Preserve any thinking blocks that might exist in the content array
        const thinkingBlocks = Array.isArray(secondLastMessage.content)
          ? secondLastMessage.content.filter(
              (item) =>
                item.type === 'thinking' || item.type === 'redacted_thinking',
            )
          : [];

        // Text blocks filtering removed - was unused

        // Anthropic models should include thinking blocks first in the content array
        // Add all thinking blocks from toolState if we have them
        if (thinkingBlocks.length > 0) {
          // if we have thinking blocks, then we use them
          this.logger.debug(
            `Using ${thinkingBlocks.length} existing thinking blocks from previous message`,
          );
          if (Array.isArray(secondLastMessage.content)) {
            secondLastMessage.content.push({
              type: 'text',
              text: bestConnector + newResponse,
            } as ContentBlockParam);
          }
        } else {
          if (Array.isArray(secondLastMessage.content)) {
            secondLastMessage.content.push({
              type: 'text',
              text: bestConnector + newResponse,
            } as ContentBlockParam);
          }
          // Add the updated text content
          // If there are existing text blocks, update with new content
          // Otherwise create a new text block with the new returned thinking block if it is not after cut off
          // we should not add the new thinking block if it is after cut off
          // but we still need to add at least somewhere...

          // let newThinkingContent: any[] = [];

          // if (toolState.reasoning.thinkingAdded && toolState.reasoning.thinkingBlocks.length > 0) {
          //   // if we have thinking blocks, then we use them
          //   this.logger.debug(
          //     `Using ${toolState.reasoning.thinkingBlocks.length} existing thinking blocks from previous message`,
          //   );
          //   newThinkingContent = [...toolState.reasoning.thinkingBlocks];
          // }

          // let newContent: any[] = [];

          // if (textBlocks.length > 0) {
          //   newContent = [...newThinkingContent, ...textBlocks];
          // } else {
          //   newContent = [
          //     ...newThinkingContent,
          //     {
          //       type: 'text',
          //       text: toolState.assembly.accumulatedOutput,
          //     },
          //   ];
          // }

          // Replace the content of the second last message with our new content array
          // secondLastMessage.content = newContent;
        }

        if (Array.isArray(secondLastMessage.content)) {
          this.assignCacheControlToLatest(secondLastMessage.content);
        }

        // Remove the user continuation prompt to keep the conversation clean
        if (messages.at(-1)?.role === 'user') {
          messages.pop();
        } else {
          this.logger.error(
            'Last message is not a user message - unexpected format',
          );
        }
      }
    } else {
      this.logger.debug(
        'Last message is a request message rather than a ask to continue after cut off',
      );
      // Create a new assistant message with the response
      const assistantMessage: MessageParam = {
        role: 'assistant',
        content: [],
      };

      // Include all thinking blocks from toolState if available
      if (
        toolState.reasoning.thinkingBlocks &&
        toolState.reasoning.thinkingBlocks.length > 0
      ) {
        this.logger.debug(
          `Adding ${toolState.reasoning.thinkingBlocks.length} thinking blocks to new assistant message`,
        );
        if (Array.isArray(assistantMessage.content)) {
          assistantMessage.content.push(...toolState.reasoning.thinkingBlocks);
        }
        // Clear cached thinking so the next response can store fresh blocks
        toolState.resetReasoning();
      }

      // Add the text content
      if (Array.isArray(assistantMessage.content)) {
        assistantMessage.content.push({
          type: 'text',
          text: toolState.assembly.accumulatedOutput,
        } as ContentBlockParam);
      }

      messages.push(assistantMessage);

      if (Array.isArray(assistantMessage.content)) {
        this.assignCacheControlToLatest(assistantMessage.content);
      }

      this.logger.debug('Added a new assistant message');
    }
  }

  /** Determines if generation should continue based on stop reason and end tag presence. */
  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    // DEBUG: Log the stop reason to help diagnose continuation issues
    this.logger.debug(
      `Checking if should continue - stop reason: "${stopReason}"`,
    );

    // Handle Claude 4 refusal stop reason - never continue when model refuses
    if (stopReason === ANTHROPIC_STOP.REFUSAL) {
      this.logger.warn(
        'Model refused to generate content - stopping generation',
      );
      return false;
    }

    // We should continue if:
    // 1. We hit the max tokens limit (stopReason === 'max_tokens')
    // 2. AND we don't have an end tag (meaning the response is incomplete)
    if (
      stopReason === ANTHROPIC_STOP.MAX_TOKENS &&
      !hasEndTag(agentSetting, newResponse)
    ) {
      return true;
    }
    if (stopReason === ANTHROPIC_STOP.STOP_SEQUENCE) {
      if (!hasEndTag(agentSetting, newResponse)) {
        return true;
      } else {
        this.logger.debug('Should not continue - no end tag found');
        return false;
      }
    }
    return false;
  }

  /**
   * Process thinking blocks for Anthropic models
   * @param responseObject The response object from Anthropic API
   * @param toolState Optional toolState to update with the thinking blocks
   * @returns The extracted thinking content (or null if none)
   * This preserves the full thinking objects including signature which is required
   * when sending back to the Anthropic API for continuing a conversation
   */
  processThinkingBlock(
    responseObject: BetaMessage,
    toolState?: AgentWorkspaceState,
  ): string | null {
    if (!responseObject) {
      return null;
    }

    // Extract all thinking blocks from the response
    const thinkingBlocks = [];
    let regularThinkingContent = null;

    try {
      if (responseObject.content && Array.isArray(responseObject.content)) {
        // Collect all thinking and redacted_thinking blocks
        for (const item of responseObject.content) {
          if (item.type === 'thinking' && item.thinking) {
            thinkingBlocks.push(item);
            // Save the first regular thinking content for returning
            if (regularThinkingContent === null) {
              regularThinkingContent = item.thinking;
            }
          } else if (item.type === 'redacted_thinking' && item.data) {
            thinkingBlocks.push(item);
          }
        }
      }
    } catch (e) {
      this.logger.error(
        `Error extracting thinking blocks: ${getSdkErrorMessage(e)}`,
        undefined,
        undefined,
        e,
      );
      return null;
    }

    if (thinkingBlocks.length === 0) {
      return null;
    }

    this.logger.debug(`Found ${thinkingBlocks.length} thinking blocks`);

    // If toolState is provided, update it with all thinking blocks
    if (toolState && !toolState.reasoning.thinkingAdded) {
      // Store all thinking blocks for future reference
      if (
        regularThinkingContent &&
        !this.containCutOffMessage(regularThinkingContent)
      ) {
        toolState.reasoning.thinkingBlocks = thinkingBlocks;
        // thinkingBlock is now a getter that returns thinkingBlocks[0]
        toolState.reasoning.thinkingAdded = true;
        this.logger.debug(
          `Added ${thinkingBlocks.length} thinking blocks to toolState`,
        );
      } else {
        this.logger.debug(
          `Skipping adding thinking blocks to toolState because of cut off message`,
        );
      }
    }

    // Return content of the first regular thinking block for logging
    return regularThinkingContent;
  }

  extractToolUse(responseObject: BetaMessage): string | null {
    const content = responseObject?.content;
    if (Array.isArray(content)) {
      const tu = content.find((c: any) => c.type === 'tool_use');
      if (tu) {
        return JSON.stringify(tu, null, 2);
      }
    }
    return null;
  }

  async createToolUseFollowUpMessages(
    client: Anthropic | undefined,
    id: string,
    name: string,
    call: ToolUseBlock,
    result: Record<string, unknown>,
    toolState?: AgentWorkspaceState,
    text?: string,
  ): Promise<MessageParam[]> {
    const content: ContentBlockParam[] = [];
    if (
      this.capabilities.supportsReasoning &&
      toolState?.reasoning.thinkingBlocks &&
      toolState.reasoning.thinkingBlocks.length > 0
    ) {
      // Anthropic models expect thinking blocks before text
      content.push(...toolState.reasoning.thinkingBlocks);
      // Clear cached thinking so the next response can store fresh blocks
      toolState.resetReasoning();
    }
    if (text) {
      content.push({ type: 'text', text });
    }
    const toolInput = call?.input ?? {};
    content.push({
      type: 'tool_use',
      id,
      name,
      input: toolInput,
    });
    const callMsg: MessageParam = {
      role: 'assistant',
      content,
    };

    const { attachments, sanitizedResult } = extractToolAttachments(result);
    const supportsAttachments = this.supportsToolFileOutputs;
    const supportsInlineImages = this.supportsInlineToolImages;

    let uploadedAttachments: UploadedAnthropicAttachment[] = [];
    const unsupportedAttachments: ToolFileAttachment[] = [];

    if (supportsAttachments && attachments.length > 0 && client) {
      const uploadResult = await this.uploadToolAttachments(
        client,
        attachments,
      );
      uploadedAttachments = uploadResult.uploaded;
      unsupportedAttachments.push(...uploadResult.unsupported);

      if (uploadedAttachments.length > 0) {
        (sanitizedResult as { files?: unknown }).files =
          uploadedAttachments.map(({ attachment, fileId }) => ({
            path: attachment.path,
            mimeType: attachment.mimeType,
            description: attachment.description,
            fileId,
          }));
      }
    } else if (attachments.length > 0) {
      unsupportedAttachments.push(...attachments);
    }

    const textPieces: string[] = [];
    if (typeof result.output === 'string' && result.output.trim().length > 0) {
      textPieces.push(result.output);
    }
    textPieces.push(JSON.stringify(sanitizedResult, null, 2));

    const toolResultContent: Array<
      TextBlockParam | ImageBlockParam | DocumentBlockParam
    > = [{ type: 'text', text: textPieces.join('\n\n') }];

    const unsupportedNotes: string[] = [];

    for (const uploaded of uploadedAttachments) {
      if (uploaded.blockType === 'image') {
        if (supportsInlineImages && uploaded.base64Data) {
          const mediaType =
            (uploaded.mediaType as BetaBase64ImageSource['media_type']) ??
            'image/png';
          toolResultContent.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: uploaded.base64Data,
            },
          } as ImageBlockParam);
        } else {
          unsupportedNotes.push(
            `${uploaded.attachment.path ?? 'attachment'} (${uploaded.attachment.mimeType})`,
          );
        }
        continue;
      }

      if (uploaded.blockType === 'document') {
        if (uploaded.base64Data) {
          const pdfMediaType =
            (uploaded.mediaType as 'application/pdf') ?? 'application/pdf';
          toolResultContent.push({
            type: 'document',
            source: {
              type: 'base64',
              media_type: pdfMediaType,
              data: uploaded.base64Data,
            },
            title: basename(uploaded.attachment.path ?? 'attachment.pdf'),
          } as DocumentBlockParam);
        } else {
          unsupportedNotes.push(
            `${uploaded.attachment.path ?? 'attachment'} (${uploaded.attachment.mimeType})`,
          );
        }
        continue;
      }

      unsupportedNotes.push(
        `${uploaded.attachment.path ?? 'attachment'} (${uploaded.attachment.mimeType})`,
      );
    }

    if (unsupportedAttachments.length > 0) {
      unsupportedNotes.push(...describeAttachments(unsupportedAttachments));
    }

    if (unsupportedNotes.length > 0) {
      toolResultContent.unshift({
        type: 'text',
        text: `Attachments available but returned as metadata only:\n${unsupportedNotes.join(
          '\n',
        )}\nUse the read_file tool if you need the raw bytes.`,
      });
      if (!(sanitizedResult as Record<string, unknown>).attachmentSummary) {
        (sanitizedResult as Record<string, unknown>).attachmentSummary =
          `Attachments available but returned as metadata only:\n${unsupportedNotes.join(
            '\n',
          )}`;
      }
    }

    if (unsupportedNotes.length > 0) {
      // Summary already added above
    }

    const isError = Boolean((result as { isError?: boolean }).isError);
    const resultMsg: MessageParam = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: toolResultContent,
          is_error: isError || undefined,
        },
      ],
    };

    const toolResultBlock = Array.isArray(resultMsg.content)
      ? resultMsg.content.at(-1)
      : undefined;
    if (isCacheControlEligibleBlock(toolResultBlock)) {
      this.setCacheControlTarget(toolResultBlock);
    }

    return [callMsg, resultMsg];
  }
}
