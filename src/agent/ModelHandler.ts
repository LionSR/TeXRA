// Standard library imports
import * as path from 'path';

// Third-party imports
// (none needed)

// Local imports - log
import { AgentLogger } from '../logger/AgentLogger';

// Local imports - utilities
import { fileExists } from '../utils/workspaceFileUtils';
import {
  getBase64EncodedMedia,
  countPdfPages,
  processPdf2Png,
  checkImageMagickInstalled,
} from '../utils/imgUtils';
import { getConfig } from '../utils/configUtils';
import {
  getApiKey as getSecretApiKey,
  ApiProvider,
} from '../utils/secretUtils';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSetting, hasEndTag } from './AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import {
  ModelConfig,
  ModelProvider,
  ModelCapabilities,
} from '../model/ModelConfig';
import { ToolState } from './ToolState';
import { MediaEntry } from './mediaTypes';

// Default continuation limits
const DEFAULT_CONTINUE_LIMIT = 10;

// Default token limits
const DEFAULT_INPUT_TOKEN_LIMIT = 1500000;
const DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR = 2.5;

/**
 * Abstract base class for model-specific handlers that manage API interactions, message processing, and response handling.
 */
export abstract class ModelHandler {
  public config: ModelConfig;
  public capabilities: ModelCapabilities;
  public continueLimit: number;
  public inputTokenLimit: number;
  public maxOutputTokensFactor: number;
  protected logger: AgentLogger;

  constructor(config: ModelConfig) {
    this.config = {
      ...config,
      toolConfig: config.toolConfig || {
        usePrefillFromInput: false,
        autoExtractFigure: false,
        autoExtractTikzFigure: false,
        reflect: false,
        attachTeXCount: false,
        printInputPrompt: false,
      },
    };
    this.capabilities = config.capabilities;
    this.continueLimit = DEFAULT_CONTINUE_LIMIT;
    this.inputTokenLimit = DEFAULT_INPUT_TOKEN_LIMIT;
    this.maxOutputTokensFactor = DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR;
    // Initialize with default channel, will be overwritten by agent
    this.logger = new AgentLogger('Agent');
  }

  /**
   * Updates the logger instance.
   */
  public setLogger(logger: AgentLogger): void {
    this.logger = logger;
  }

  /**
   * Retrieves API key from environment variables based on provider and OpenRouter configuration.
   * @throws Error if required API key is missing from environment
   */
  public async getApiKey(): Promise<string> {
    // Use OpenRouter if model requires it or if explicitly configured
    const useOpenRouter =
      this.config.openRouterOnly ||
      getConfig<boolean>('model.useOpenRouter', false);

    if (useOpenRouter) {
      try {
        return await getSecretApiKey('openRouter');
      } catch (err) {
        throw new Error(
          'Missing API key for OpenRouter. Please set it using the "Set API Key" command.',
        );
      }
    }

    const provider = this.config.provider.toLowerCase() as ApiProvider;
    try {
      return await getSecretApiKey(provider);
    } catch (err) {
      throw new Error(
        `Missing API key for ${this.config.provider}. Please set it using the "Set API Key" command.`,
      );
    }
  }

  /**
   * Retrieves base URL for API requests based on provider and OpenRouter configuration.
   * @returns Base URL string or null for providers using default URLs
   */
  public getBaseUrl(): string | null {
    // Use OpenRouter if model requires it or if explicitly configured
    const useOpenRouter =
      this.config.openRouterOnly ||
      getConfig<boolean>('model.useOpenRouter', false);

    if (useOpenRouter) {
      return 'https://openrouter.ai/api/v1';
    }

    // Provider-specific base URLs
    const BASE_URLS: Record<ModelProvider, string | null> = {
      [ModelProvider.GOOGLE]:
        'https://generativelanguage.googleapis.com/v1beta/openai/',
      [ModelProvider.OPENAI]: null, // OpenAI uses default base URL
      [ModelProvider.ANTHROPIC]: 'https://api.anthropic.com/v1/',
      [ModelProvider.DEEPSEEK]: 'https://api.deepseek.com',
      [ModelProvider.XAI]: 'https://api.x.ai/v1',
      [ModelProvider.MOONSHOT]: 'https://api.moonshot.cn/v1',
      [ModelProvider.DASHSCOPE]:
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      [ModelProvider.OTHERS]: null,
    };
    return BASE_URLS[this.config.provider];
  }

  /** Checks if the model uses an OpenAI-compatible API format. */
  get isOpenaiCompatible(): boolean {
    return [
      ModelProvider.OPENAI,
      ModelProvider.GOOGLE,
      ModelProvider.OTHERS,
      ModelProvider.DEEPSEEK,
      ModelProvider.XAI,
      ModelProvider.MOONSHOT,
      ModelProvider.DASHSCOPE,
      ModelProvider.ANTHROPIC,
    ].includes(this.config.provider);
  }

  /** Checks if the model is from Anthropic provider. */
  get isAnthropic(): boolean {
    return this.config.provider === ModelProvider.ANTHROPIC;
  }

  /** Checks if the model is from OpenAI provider. */
  get isOpenai(): boolean {
    return this.config.provider === ModelProvider.OPENAI;
  }

  /** Checks if the model is from Google provider. */
  get isGoogle(): boolean {
    return this.config.provider === ModelProvider.GOOGLE;
  }

  /**
   * Gets streaming configuration for the current model provider
   * @returns Boolean indicating if streaming should be enabled
   */
  public getStreamingConfig(): boolean {
    const useStreamingGlobal = getConfig<boolean>('model.useStreaming', false);

    // For OpenRouter models, use dedicated setting
    if (
      this.config.openRouterOnly ||
      getConfig<boolean>('model.useOpenRouter', false)
    ) {
      return getConfig<boolean>(
        'model.useStreamingOpenrouter',
        useStreamingGlobal,
      );
    }

    // Map ModelProvider enum to configuration key suffix
    const providerConfigMap: Record<ModelProvider, string> = {
      [ModelProvider.ANTHROPIC]: 'Anthropic',
      [ModelProvider.OPENAI]: 'Openai',
      [ModelProvider.GOOGLE]: 'Google',
      [ModelProvider.DEEPSEEK]: 'Deepseek',
      [ModelProvider.MOONSHOT]: 'Moonshot',
      [ModelProvider.DASHSCOPE]: 'Dashscope',
      [ModelProvider.XAI]: 'Xai',
      [ModelProvider.OTHERS]: '', // Will fall back to global
    };

    const configSuffix = providerConfigMap[this.config.provider];

    // If no mapping exists or it's the OTHERS provider, just use global setting
    if (!configSuffix) {
      return useStreamingGlobal;
    }

    // Build the full config key and fetch the setting
    const configKey = `model.useStreaming${configSuffix}`;
    return getConfig<boolean>(configKey, useStreamingGlobal);
  }

  get isOReasoningModelFull(): boolean {
    const nameLowerCased = this.config.name.toLowerCase();
    if (
      nameLowerCased.includes('o1-') ||
      nameLowerCased.includes('o1preview')
    ) {
      return false;
    }
    return (
      nameLowerCased.includes('o1') ||
      nameLowerCased.includes('o3') ||
      nameLowerCased.includes('o4')
    );
  }

  get isOReasoningModel(): boolean {
    const nameLowerCased = this.config.name.toLowerCase();
    return (
      nameLowerCased.includes('o1') ||
      nameLowerCased.includes('o3') ||
      nameLowerCased.includes('o4')
    );
  }

  /**
   * Validates reasoning effort based on provider-specific support
   * @param effort The reasoning effort level to validate
   * @returns Valid reasoning effort string for the current provider
   */
  protected validateReasoningEffort(effort: string): string {
    // Default implementation - return as is for most providers
    if (this.config.provider === ModelProvider.XAI) {
      // xAI models only support 'low' and 'high'
      if (effort === 'low' || effort === 'high') {
        return effort;
      }

      // Default to 'high' for other values
      this.logger.warn(
        `xAI models only support 'low' or 'high' reasoning effort. Converting '${effort}' to 'high'.`,
      );
      return 'high';
    }

    // For other providers, return effort as is
    return effort;
  }

  /**
   * Process image or audio for models.
   * @param mediaFile Path to the media file
   * @param fileExtension File extension (e.g. '.jpg', '.pdf', '.wav')
   * @returns Tuple of [base64 encoded media data, media type, media category ('image' or 'audio')]
   */
  protected async processMedia(
    mediaFile: string,
    fileExtension: string,
  ): Promise<[string | string[], string, 'image' | 'audio']> {
    const ext = fileExtension.toLowerCase();
    let mediaData: string | string[];
    let mediaType: string;
    let mediaCategory: 'image' | 'audio';

    const imageMediaTypes: { [key: string]: string } = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.heic': 'image/heic',
      '.heif': 'image/heif',
      '.gif': 'image/gif',
      '.pdf': await (async () => {
        // Check if ImageMagick is installed
        const isImageMagickInstalled = await checkImageMagickInstalled();
        const pageCount = await countPdfPages(mediaFile);

        // Use native PDF in these cases:
        // 1. Multi-page PDF and model supports native PDFs, or
        // 2. ImageMagick not installed but model supports native PDFs
        if (
          (pageCount > 1 || !isImageMagickInstalled) &&
          this.capabilities.supportsNativePdf
        ) {
          this.logger.debug(
            `Using native PDF for ${mediaFile}. ImageMagick installed: ${isImageMagickInstalled}, Page count: ${pageCount}`,
          );
          return 'application/pdf';
        }

        // Default to PNG conversion when ImageMagick is available
        return 'image/png';
      })(),
    };

    const audioMediaTypes: { [key: string]: string } = {
      '.wav': 'audio/wav',
      '.m4a': 'audio/m4a',
      '.mp3': 'audio/mp3',
      '.mpeg': 'audio/mpeg',
      '.aiff': 'audio/aiff',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/flac',
    };

    if (ext in imageMediaTypes) {
      mediaType = imageMediaTypes[ext];
      mediaCategory = 'image';
      this.logger.debug(
        `Processing as image: ${mediaFile}, type: ${mediaType}`,
      );
      if (ext === '.pdf') {
        if (mediaType === 'image/png') {
          // Only attempt conversion if we've determined PNG is appropriate
          this.logger.debug(`Converting PDF to PNG: ${mediaFile}`);
          const pdfResult = await processPdf2Png(mediaFile);

          if (pdfResult === null) {
            // If conversion fails but model supports native PDF, fall back to PDF
            if (this.capabilities.supportsNativePdf) {
              this.logger.info(
                `PDF to PNG conversion failed. Falling back to native PDF for ${mediaFile}`,
              );
              mediaType = 'application/pdf';
              mediaData = await getBase64EncodedMedia(mediaFile);
            } else {
              throw new Error(
                `Failed to process PDF file as image: ${mediaFile}`,
              );
            }
          } else {
            mediaData = pdfResult;
          }
        } else {
          // For application/pdf media type, use PDF directly
          this.logger.debug(`Using native PDF: ${mediaFile}`);
          mediaData = await getBase64EncodedMedia(mediaFile);
        }
      } else {
        mediaData = await getBase64EncodedMedia(mediaFile);
      }
    } else if (
      ext in audioMediaTypes &&
      this.capabilities.supportsNativeAudio
    ) {
      mediaType = audioMediaTypes[ext];
      mediaCategory = 'audio';
      this.logger.debug(
        `Processing as audio: ${mediaFile}, type: ${mediaType}`,
      );
      mediaData = await getBase64EncodedMedia(mediaFile);
      // Audio files are typically processed as a single base64 string
      if (Array.isArray(mediaData)) {
        this.logger.warn(
          `Audio file ${mediaFile} processed into multiple parts, using only the first.`,
        );
        // I think this should not happen, but just in case
        mediaData = mediaData[0];
      }
    } else {
      throw new Error(
        `Unsupported or disabled file extension: ${fileExtension}. Image support: ${this.capabilities.supportsVision}, Audio support: ${this.capabilities.supportsNativeAudio}`,
      );
    }

    return [mediaData, mediaType, mediaCategory];
  }

  /**
   * Create image/audio messages for the conversation.
   * This is a shared implementation that can be used by all providers.
   * Individual providers can override if needed.
   */
  public async createMediaMessage(mediaFiles: string[]): Promise<any[]> {
    const mediaMessage: MediaEntry[] = [];
    const addedMedia: string[] = [];

    for (const mediaFile of mediaFiles) {
      if (!(await fileExists(mediaFile))) {
        this.logger.error(`File not found: ${mediaFile}`);
        continue;
      }

      const fileExtension = path.extname(mediaFile).toLowerCase();

      try {
        this.logger.debug(`Processing media: ${mediaFile}`);
        const [mediaData, mediaType, mediaCategory] = await this.processMedia(
          mediaFile,
          fileExtension,
        );
        this.logger.debug(
          `Processed ${mediaCategory}: ${mediaFile}, type: ${mediaType}`,
        );

        // Special handling for OpenAI native PDF support
        if (
          this.isOpenai &&
          this.capabilities.supportsVision &&
          this.capabilities.supportsNativePdf &&
          mediaType === 'application/pdf'
        ) {
          const imageEntry: MediaEntry = {
            file_name: path.basename(mediaFile),
            data: Array.isArray(mediaData) ? mediaData[0] : mediaData,
            media_type: mediaType,
            media_category: mediaCategory,
          };
          mediaMessage.push(imageEntry);
          addedMedia.push(mediaFile);
          this.logger.debug(`Added native PDF: ${mediaFile}`);
          continue;
        }

        if (Array.isArray(mediaData)) {
          this.logger.debug(
            `Adding ${mediaData.length} pages/parts to the media contents`,
          );
          for (let i = 0; i < mediaData.length; i++) {
            const mediaEntry: MediaEntry = {
              file_name: `${path.basename(mediaFile)}_page_${i + 1}`,
              data: mediaData[i],
              media_type: mediaType,
              media_category: mediaCategory,
            };
            mediaMessage.push(mediaEntry);
            addedMedia.push(`${mediaFile}_page_${i + 1}`);
          }
        } else {
          this.logger.debug(
            `Adding single part to the media contents: ${mediaFile}`,
          );
          const mediaEntry: MediaEntry = {
            file_name: path.basename(mediaFile),
            data: mediaData,
            media_type: mediaType,
            media_category: mediaCategory,
          };
          mediaMessage.push(mediaEntry);
          addedMedia.push(mediaFile);
        }
      } catch (err) {
        this.logger.error(`Failed to process media ${mediaFile}: ${err}`);
        continue;
      }
    }

    if (mediaFiles.length > 0) {
      this.logger.info(`Trying to load media: ${mediaFiles}`);
      this.logger.info(`Successfully added: ${addedMedia}`);
    }

    return this.createMediaContent(mediaMessage);
  }

  /**
   * Evaluates conversation stop conditions based on model response and state.
   * @returns Tuple of [endTurn: should end current turn, shouldStop: should stop conversation]
   */
  public checkStopConditions(
    stopReason: string,
    newResponse: string,
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    agentSetting: AgentSetting,
  ): [boolean, boolean] {
    const maxOutputTokens =
      stateGlobal.firstInputTokens > 0
        ? this.maxOutputTokensFactor * stateGlobal.firstInputTokens
        : Number.POSITIVE_INFINITY;

    const endTurn = ['end_turn', 'stop_sequence', 'stop', 'STOP'].includes(
      stopReason,
    );
    const encounterDocumentTag = newResponse.includes(
      `</${agentSetting.documentTag}>`,
    );
    const continuationLimit = stateRound.continuationCount > this.continueLimit;
    const inputTokenLimit = stateGlobal.totalInputTokens > this.inputTokenLimit;
    const maxOutputTokensExceeded =
      stateGlobal.totalOutputTokens > maxOutputTokens;

    if (maxOutputTokensExceeded) {
      this.logger.warn(
        `Output tokens exceed ${this.maxOutputTokensFactor}x input tokens`,
      );
      this.logger.warn(
        `Total output tokens: ${stateGlobal.totalOutputTokens}, First input tokens: ${stateGlobal.firstInputTokens}`,
      );
    }

    const shouldStop =
      encounterDocumentTag || continuationLimit || inputTokenLimit;

    // Print debug info if stopping
    if (shouldStop) {
      this.logger.debug(
        `StopFlags:
                endTurn: ${endTurn}
                encounterDocumentTag: ${encounterDocumentTag}
                continuation_limit: ${continuationLimit}
                inputTokenLimit: ${inputTokenLimit}
                maxOutputTokens: ${maxOutputTokensExceeded}`,
      );
    }

    return [endTurn, shouldStop];
  }

  public containCutOffMessage(content: any[] | string): boolean {
    if (typeof content === 'string') {
      return content.includes('Your response got cut off');
    }
    return content.some((c: { type: string; text: string }) =>
      c.text?.includes('Your response got cut off'),
    );
  }

  /** Creates and configures a client instance for the specific model provider. */
  abstract getClient(): Promise<any>;

  /**
   * Generates a model response using the provider's API.
   * @returns Promise resolving to provider-specific response object
   */
  abstract createResponse(
    client: any,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
  ): Promise<any>;

  /**
   * Creates initial message array for conversation with optional images and system prompt.
   * @returns Promise resolving to provider-specific message array
   */
  abstract initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: string[],
    systemPrompt?: string,
  ): Promise<any[]>;

  /**
   * Creates reflection messages for multi-turn conversations with optional images.
   * @returns Provider-specific message array with reflection content
   */
  abstract createReflectionMessages(
    messages: any[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<any[]>;

  /**
   * Formats image content into provider-specific message format.
   * @returns Array of formatted image/document content objects
   */
  abstract createMediaContent(mediaMessage: MediaEntry[]): any[];

  /**
   * Extracts the response text and metadata from the model's response object
   * @param responseObject The raw response object from the model
   * @param endTag The end tag to append if needed
   * @returns A tuple containing [responseText, usageInfo, stopReason]
   */
  abstract extractResponse(
    responseObject: any,
    endTag: string,
  ): [string, any, string];

  /**
   * Manages continuation for truncated responses in multi-turn conversations with prefill support.
   * Updates messages array and tool state for next turn.
   */
  abstract addContinueMessageWithPrefill(
    messages: any[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void;

  /**
   * Manages continuation for truncated responses in multi-turn conversations without prefill support.
   * Updates messages array and tool state for next turn.
   */
  abstract addContinueMessageWithoutPrefill(
    messages: any[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void;

  /**
   * Sets up output file and handles content prefilling.
   * @returns Promise resolving to [isComplete: generation complete, messages: updated message array]
   */
  abstract initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: any[],
    toolState: ToolState,
    outputFile: string,
    prefill: string,
  ): Promise<[boolean, any[]]>;

  /**
   * Calculates API usage cost based on token counts and provider pricing.
   * @returns Total cost in provider's currency units
   */
  abstract computePrice(responseUsage: any): number;

  /**
   * Computes detailed usage metrics from model response.
   * @returns Provider-specific response usage object
   */
  abstract computeResponseUsage(responseUsage: any, responseTime: number): any;

  /**
   * Updates model message content with response for models with prefill support.
   * Handles cache control and content formatting.
   */
  abstract updateMessageContentWithPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void;

  /**
   * Updates model message content with response for models without prefill support.
   * Handles cache control and content formatting.
   */
  abstract updateMessageContentWithoutPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void;

  /**
   * Determines if model should continue generating based on response state.
   * @returns Boolean indicating if generation should continue
   */
  abstract shouldContinue(
    stopReason: string,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean;

  /**
   * Extracts thinking content from model responses
   * @param responseObject The raw response object from the model
   * @param groupId Optional group ID for logging
   * @param toolState Optional toolState to update with the thinking block
   * @returns The extracted thinking content string or null if no thinking content is available
   */
  abstract processThinkingBlock(
    responseObject: any,
    groupId?: string,
    toolState?: ToolState,
  ): string | null;

  /**
   * Creates a log group for model operations with the given name.
   * @param name Name of the operation group
   * @param parentGroupId Optional parent group ID
   * @returns The group ID
   */
  protected async createOperationGroup(
    name: string,
    parentGroupId?: string,
  ): Promise<string> {
    return await this.logger.startGroup(
      `Model Operation: ${name}`,
      undefined,
      parentGroupId,
    );
  }

  /**
   * Ends a model operation log group with the given status.
   * @param groupId ID of the group to end
   * @param status Status of the operation ('error' or 'stopped')
   */
  protected endOperationGroup(
    groupId: string,
    status: 'error' | 'stopped' = 'stopped',
  ): void {
    this.logger.endGroup(groupId, status);
  }
}
