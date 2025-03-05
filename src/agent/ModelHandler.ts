// Standard library imports
import * as path from 'path';

// Third-party imports
// (none needed)

// Local imports - log
import { AgentLogger } from '../logger/AgentLogger';

// Local imports - utilities
import { fileExists } from '../utils/workspaceFileUtils';
import {
  getBase64EncodedImage,
  countPdfPages,
  processPdf2Png,
} from '../utils/imgUtils';
import { getConfig } from '../frontend-utils/commonUtils';
import {
  getApiKey as getSecretApiKey,
  ApiProvider,
} from '../utils/secretUtils';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSetting, hasEndTag } from './AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { ModelConfig, ModelProvider, ModelCapabilities } from './ModelConfig';
import { ToolState } from './ToolState';

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
          'Missing OpenRouter API key. Please set it using the "Set API Key" command.',
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
      [ModelProvider.ANTHROPIC]: null, // Anthropic uses default base URL
      [ModelProvider.DEEPSEEK]: 'https://api.deepseek.com',
      [ModelProvider.XAI]: 'https://api.x.ai/v1',
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

  get isOReasoningModelFull(): boolean {
    const nameLowerCased = this.config.name.toLowerCase();
    if (
      nameLowerCased.includes('o1-') ||
      nameLowerCased.includes('o1preview')
    ) {
      return false;
    }
    return nameLowerCased.includes('o1') || nameLowerCased.includes('o3');
  }

  get isOReasoningModel(): boolean {
    const nameLowerCased = this.config.name.toLowerCase();
    return nameLowerCased.includes('o1') || nameLowerCased.includes('o3');
  }

  /**
   * Process image for models.
   * @param figureFile Path to the image file
   * @param fileExtension File extension (e.g. '.jpg', '.pdf')
   * @returns Tuple of [base64 encoded image data, media type]
   */
  protected async processImage(
    figureFile: string,
    fileExtension: string,
  ): Promise<[string | string[], string]> {
    let imgData: string | string[];
    const ext = fileExtension.toLowerCase();

    const mediaTypes: { [key: string]: string } = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.pdf':
        this.capabilities.supportsNativePdf &&
        (await countPdfPages(figureFile)) > 1
          ? 'application/pdf'
          : 'image/png',
    };

    if (!(ext in mediaTypes)) {
      throw new Error(`Unsupported file extension: ${fileExtension}`);
    }

    const mediaType = mediaTypes[ext];
    if (ext === '.pdf' && mediaType === 'image/png') {
      const pdfResult = await processPdf2Png(figureFile);
      if (pdfResult === null) {
        throw new Error(`Failed to process PDF file: ${figureFile}`);
      }
      imgData = pdfResult;
    } else {
      imgData = await getBase64EncodedImage(figureFile);
    }

    return [imgData, mediaType];
  }

  /**
   * Create image messages for the conversation.
   * This is a shared implementation that can be used by all providers.
   * Individual providers can override if needed.
   */
  public async createImageMessage(figureFiles: string[]): Promise<any[]> {
    const imageContents: any[] = [];
    const addedFigures: string[] = [];

    for (const figureFile of figureFiles) {
      if (!(await fileExists(figureFile))) {
        this.logger.error(`File not found: ${figureFile}`);
        continue;
      }

      const fileExtension = path.extname(figureFile).toLowerCase();

      try {
        this.logger.debug(`Processing image: ${figureFile}`);
        const [imgData, mediaType] = await this.processImage(
          figureFile,
          fileExtension,
        );
        this.logger.debug(`Processed image: ${figureFile}, type: ${mediaType}`);

        if (Array.isArray(imgData)) {
          this.logger.debug(
            `Adding ${imgData.length} pages to the image contents`,
          );
          for (let i = 0; i < imgData.length; i++) {
            const imageEntry = {
              file_name: `${path.basename(figureFile)}_page_${i + 1}`,
              data: imgData[i],
              media_type: mediaType,
            };
            imageContents.push(imageEntry);
            addedFigures.push(`${figureFile}_page_${i + 1}`);
          }
        } else {
          this.logger.debug(
            `Adding single page to the image contents: ${figureFile}`,
          );
          const imageEntry = {
            file_name: path.basename(figureFile),
            data: imgData,
            media_type: mediaType,
          };
          imageContents.push(imageEntry);
          addedFigures.push(figureFile);
        }
      } catch (err) {
        this.logger.error(`Failed to process image ${figureFile}: ${err}`);
        continue;
      }
    }

    if (figureFiles.length > 0) {
      this.logger.info(`Trying to load images: ${figureFiles}`);
      this.logger.info(`Successfully added: ${addedFigures}`);
    }

    return this.createImageContent(imageContents);
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

    const endTurn = ['end_turn', 'stop_sequence', 'stop'].includes(stopReason);
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
    figureFiles?: string[],
    systemPrompt?: string,
  ): Promise<any[]>;

  /**
   * Creates reflection messages for multi-turn conversations with optional images.
   * @returns Provider-specific message array with reflection content
   */
  abstract createReflectionMessages(
    messages: any[],
    userMessage: string,
    figureFiles?: string[],
  ): Promise<any[]>;

  /**
   * Formats image content into provider-specific message format.
   * @returns Array of formatted image/document content objects
   */
  abstract createImageContent(imageContents: any[]): any[];

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
