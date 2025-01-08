// Standard library imports
import * as path from 'path';

// Third-party imports
// (none needed)

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { fileExists } from '../utils/fileUtils';
import {
  getBase64EncodedImage,
  countPdfPages,
  singlePagePdf2Png,
  multiPagePdf2Png,
  processPdfInput,
} from '../utils/imgUtils';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSetting } from './AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { ModelConfig, ModelProvider, ModelCapabilities } from './ModelConfig';
import { ToolState } from './ToolState';

// Default continuation limits
const DEFAULT_CONTINUE_LIMIT = 10;
const CONFIRMATION_CONTINUE_LIMIT = 20;

// Default token limits
const DEFAULT_INPUT_TOKEN_LIMIT = 1500000;
const DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR = 2.5;

const CHANNEL = 'Agent';
logger.initialize(CHANNEL);

/**
 * Abstract base class for model-specific handlers that manage API interactions, message processing, and response handling.
 */
export abstract class ModelHandler {
  public config: ModelConfig;
  public capabilities: ModelCapabilities;
  public continueLimit: number;
  public inputTokenLimit: number;
  public maxOutputTokensFactor: number;

  constructor(config: ModelConfig) {
    this.config = config;
    this.capabilities = config.capabilities;
    this.continueLimit = this.capabilities.likesToAskForConfirmation
      ? CONFIRMATION_CONTINUE_LIMIT
      : DEFAULT_CONTINUE_LIMIT;
    this.inputTokenLimit = DEFAULT_INPUT_TOKEN_LIMIT;
    this.maxOutputTokensFactor = DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR;
  }

  /**
   * Retrieves API key from environment variables based on provider and OpenRouter configuration.
   * @throws Error if required API key is missing from environment
   */
  public getApiKey(): string {
    if (this.config.useOpenRouter) {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) {
        throw new Error('Missing OPENROUTER_API_KEY in environment');
      }
      return key;
    }

    const envKey = `${this.config.provider.toUpperCase()}_API_KEY`;
    const key = process.env[envKey];
    if (!key) {
      throw new Error(`Missing ${envKey} in environment`);
    }
    return key;
  }

  /**
   * Retrieves base URL for API requests based on provider and OpenRouter configuration.
   * @returns Base URL string or null for providers using default URLs
   */
  public getBaseUrl(): string | null {
    if (this.config.useOpenRouter) {
      return 'https://openrouter.ai/api/v1';
    }

    // Provider-specific base URLs
    const BASE_URLS: Record<ModelProvider, string | null> = {
      [ModelProvider.GOOGLE]:
        'https://generativelanguage.googleapis.com/v1beta/openai/',
      [ModelProvider.OPENAI]: null, // OpenAI uses default base URL
      [ModelProvider.ANTHROPIC]: null, // Anthropic uses default base URL
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
      const pdfResult = await processPdfInput(figureFile);
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
      try {
        if (!(await fileExists(figureFile))) {
          logger.error(CHANNEL, `File not found: ${figureFile}`);
          continue;
        }

        const fileExtension = path.extname(figureFile).toLowerCase();

        try {
          const [imgData, mediaType] = await this.processImage(
            figureFile,
            fileExtension,
          );
          logger.debug(
            CHANNEL,
            `Processed image: ${figureFile}, type: ${mediaType}`,
          );

          if (Array.isArray(imgData)) {
            logger.debug(
              CHANNEL,
              `Adding ${imgData.length} pages to the image contents`,
            );
            for (let i = 0; i < imgData.length; i++) {
              imageContents.push({
                file_name: `${path.basename(figureFile)}_page_${i + 1}`,
                data: imgData[i],
                media_type: mediaType,
              });
              addedFigures.push(`${figureFile}_page_${i + 1}`);
            }
          } else {
            logger.debug(
              CHANNEL,
              `Adding single page to the image contents: ${figureFile}`,
            );
            imageContents.push({
              file_name: path.basename(figureFile),
              data: imgData,
              media_type: mediaType,
            });
            addedFigures.push(figureFile);
          }
        } catch (err) {
          logger.error(
            CHANNEL,
            `Failed to process image ${figureFile}: ${err}`,
          );
          continue;
        }
      } catch (err) {
        logger.error(CHANNEL, `Failed to process image ${figureFile}: ${err}`);
        continue;
      }
    }

    logger.info(CHANNEL, `Using images: ${figureFiles}`);
    logger.info(CHANNEL, `Successfully added: ${addedFigures}`);

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
      logger.warn(
        CHANNEL,
        `Output tokens exceed ${this.maxOutputTokensFactor}x input tokens`,
      );
      logger.warn(
        CHANNEL,
        `Total output tokens: ${stateGlobal.totalOutputTokens}, First input tokens: ${stateGlobal.firstInputTokens}`,
      );
    }

    const shouldStop =
      encounterDocumentTag || continuationLimit || inputTokenLimit;

    // Print debug info if stopping
    if (shouldStop) {
      logger.debug(
        CHANNEL,
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

  /** Creates and configures a client instance for the specific model provider. */
  abstract getClient(): any;

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
  ): any[];

  /**
   * Formats image content into provider-specific message format.
   * @returns Array of formatted image/document content objects
   */
  abstract createImageContent(imageContents: any[]): any[];

  /**
   * Processes model response, handling errors and formatting.
   * @returns Tuple of [formatted response text, usage statistics, stop reason]
   */
  abstract extractResponse(
    responseObject: any,
    endTag: string,
    autoConfirmation?: boolean,
  ): [string, any, string];

  /**
   * Manages continuation for truncated responses in multi-turn conversations.
   * Updates messages array and tool state for next turn.
   */
  abstract addContinueMessage(
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
   * Updates conversation message content with new responses.
   * Handles cache control and content formatting.
   */
  abstract updateMessageContent(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
    autoConfirmation?: boolean,
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
}
