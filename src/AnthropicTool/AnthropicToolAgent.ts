// Standard library imports
import * as vscode from 'vscode';

// Third-party imports
import Anthropic from '@anthropic-ai/sdk';

// Local imports - error utils
import { getSdkErrorMessage } from '../utils/sdkErrorUtils';

// Local imports - core
import { TextEditorTool } from './TextEditorTool';
import { ToolResult } from './base';
import { BaseError, ValidationResult } from './types';

// Local imports - utils
import * as workspaceFileUtils from '../utils/workspaceFileUtils';
import {
  getApiKey as getSecretApiKey,
  ApiProvider,
} from '../utils/secretUtils';
import { getConfig } from '../utils/configUtils';

// Local imports - logging
import * as logger from '../logger/logUtils';

const CHANNEL = 'AnthropicToolAgent';
logger.initialize(CHANNEL);

/**
 * Abstract base class for agents that use Claude to fix issues in files
 */
export abstract class AnthropicToolAgent<
  ErrorType extends BaseError | BaseError[],
> {
  // Constants used throughout the class
  protected static readonly MAX_ALLOWED_ITERATIONS: number = 20;
  protected static readonly DEFAULT_ITERATIONS: number = 10;
  protected static readonly DEFAULT_CONTEXT_LINES: number = 10;
  protected static readonly DEFAULT_MAX_TOKENS: number = 1024;

  protected textEditorTool: TextEditorTool;
  protected model: string = 'claude-3-7-sonnet-latest';
  protected readonly agentName: string;
  protected readonly configKey: string;
  protected maxIterations: number = AnthropicToolAgent.DEFAULT_ITERATIONS;
  protected contextLines: number = AnthropicToolAgent.DEFAULT_CONTEXT_LINES;
  protected maxTokens: number = AnthropicToolAgent.DEFAULT_MAX_TOKENS;

  constructor() {
    // Use different text editor tool for Claude 4 models vs older models
    const isClaude4Model =
      this.model.includes('claude-opus-4') ||
      this.model.includes('claude-sonnet-4');
    const textEditorType = isClaude4Model
      ? 'text_editor_20250429'
      : 'text_editor_20250124';
    this.textEditorTool = new TextEditorTool(textEditorType);

    // Derive agent name from class name
    this.agentName = this.constructor.name;

    // Remove 'Agent' suffix if present and convert to camelCase for config key
    const baseName = this.agentName.replace(/Agent$/, '');
    this.configKey = `${baseName.charAt(0).toLowerCase() + baseName.slice(1)}.maxIterations`;

    // Use agent name as log channel
    logger.initialize(CHANNEL);

    // Initialize maxIterations from config
    this.maxIterations = getConfig(
      this.configKey,
      AnthropicToolAgent.DEFAULT_ITERATIONS,
    );
  }

  /**
   * Fix issues in the specified file.
   *
   * @param filePath Path to the file to fix
   * @returns Whether the fixing was successful
   */
  public async fixIssues(filePath: string): Promise<boolean> {
    logger.info(CHANNEL, `Starting issue fixing for ${filePath}`);

    try {
      // Verify the file exists before starting
      const fileExists = await workspaceFileUtils.fileExists(filePath);
      if (!fileExists) {
        logger.error(CHANNEL, `File does not exist: ${filePath}`);
        vscode.window.showErrorMessage(`File does not exist: ${filePath}`);
        return false;
      }

      // Initial validation
      const validationResult = await this.validateFile(filePath);

      // Log validation result for debugging
      logger.debug(
        CHANNEL,
        `Validation result: ${JSON.stringify(validationResult)}`,
      );

      // If content is already valid, no need to fix anything
      if (validationResult.isValid) {
        logger.info(CHANNEL, `No issues found in ${filePath}`);
        vscode.window.showInformationMessage(`No issues found in ${filePath}`);
        return true;
      }

      // Log the issues
      logger.warn(
        CHANNEL,
        `Validation failed: ${JSON.stringify(validationResult.error)}`,
      );

      // Read file content for context
      const content = await workspaceFileUtils.readFile(filePath);

      // Get the context around the error
      let errorContext = '';
      if (validationResult.error) {
        errorContext = this.getErrorContext(content, validationResult.error);
      } else {
        // Default context if no error is provided
        errorContext = this.getDefaultContext(content);
      }

      // Call Claude to fix the issues
      const fixResult = await this.callClaudeToFix(
        filePath,
        this.createInitialUserMessage(validationResult, filePath, errorContext),
        (result) => this.createSystemMessage(result),
        (result, isFixed, currentIteration) =>
          this.createFollowUpMessage(result, isFixed, currentIteration),
        (path) => this.validateFile(path),
        (contentText, errorData) =>
          this.getErrorContext(contentText, errorData),
      );

      // Final validation to check if all issues are fixed
      const finalValidation = await this.validateFile(filePath);

      if (finalValidation.isValid) {
        logger.info(CHANNEL, `Successfully fixed all issues in ${filePath}`);
        vscode.window.showInformationMessage(
          `Successfully fixed all issues in ${filePath}`,
        );
        return true;
      } else {
        logger.warn(
          CHANNEL,
          `Could not fix all issues. Remaining: ${JSON.stringify(finalValidation.error)}`,
        );
        vscode.window.showErrorMessage(
          `Could not fix all issues in ${filePath}. See log for details.`,
        );
        return false;
      }
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error in fixIssues: ${this.formatErrorMessage(err)}`,
      );
      vscode.window.showErrorMessage(
        `Error fixing issues: ${this.formatErrorMessage(err)}`,
      );
      return false;
    }
  }

  /**
   * Get Anthropic API key from secure storage
   */
  protected async getApiKey(): Promise<string> {
    try {
      return await getSecretApiKey('anthropic' as ApiProvider);
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error getting Anthropic API key: ${this.formatErrorMessage(err)}`,
      );
      throw new Error(
        'Missing API key from Anthropic. Please set it using the "Set API Key" command.',
      );
    }
  }

  /**
   * Call Claude API to fix issues in a file
   */
  protected async callClaudeToFix(
    filePath: string,
    initialUserMessage: string,
    createSystemMessage: (
      validationResult: ValidationResult<ErrorType>,
    ) => string,
    createFollowUpMessage: (
      validationResult: ValidationResult<ErrorType>,
      isFixed: boolean,
      currentIteration: number,
    ) => string,
    validateFix: (filePath: string) => Promise<ValidationResult<ErrorType>>,
    getErrorContext: (content: string, error: ErrorType) => string,
  ): Promise<ToolResult> {
    try {
      // Verify the file exists before starting
      const fileExists = await workspaceFileUtils.fileExists(filePath);
      if (!fileExists) {
        logger.error(CHANNEL, `File does not exist: ${filePath}`);
        vscode.window.showErrorMessage(`File does not exist: ${filePath}`);
        return new ToolResult({
          error: `File does not exist: ${filePath}`,
          isError: true,
        });
      }

      // Get the API key for Anthropic
      const apiKey = await this.getApiKey();

      // Create Anthropic client
      const client = new Anthropic({ apiKey });

      // Initial validation
      let validationResult = await validateFix(filePath);

      // If already valid, we're done
      if (validationResult.isValid) {
        logger.info(CHANNEL, `File is already valid: ${filePath}`);
        vscode.window.showInformationMessage(
          `File is already valid: ${filePath}`,
        );
        return new ToolResult({
          output: 'File is already valid',
          isError: false,
        });
      }

      // Read file content for error context
      let content = await workspaceFileUtils.readFile(filePath);

      // Get initial error context
      let errorContext = '';
      if (validationResult.error) {
        errorContext = getErrorContext(content, validationResult.error);
      } else {
        // Default context if no error is provided
        errorContext = this.getDefaultContext(content);
      }

      // Initialize conversation
      const messages = [
        {
          role: 'user' as const,
          content: initialUserMessage,
        },
      ];

      // Maximum conversation turns to try
      let currentIteration = 0;
      let lastToolResult: ToolResult | null = null;
      let isFixed = false;

      // Continue the conversation until we fix the issues or reach max iterations
      while (currentIteration < this.maxIterations && !isFixed) {
        currentIteration++;
        logger.info(
          CHANNEL,
          `Iteration ${currentIteration}/${this.maxIterations}`,
        );

        // Make the system message with current validation error
        const systemMessage = createSystemMessage(validationResult);

        // Call Claude API
        const response = await client.messages.create({
          model: this.model,
          max_tokens: this.maxTokens,
          system: systemMessage,
          messages,
          tools: [this.textEditorTool.toParams() as any], // Type assertion needed for Claude 4 compatibility
        });

        logger.debug(
          CHANNEL,
          `Claude response (iteration ${currentIteration}): ${JSON.stringify(response)}`,
        );

        // Process tool use in Claude's response
        const toolUseContent = response.content.find(
          (c) => c.type === 'tool_use',
        );
        if (!toolUseContent || toolUseContent.type !== 'tool_use') {
          logger.warn(
            CHANNEL,
            `Claude didn't use any tools in iteration ${currentIteration}`,
          );
          break;
        }

        logger.info(CHANNEL, `Processing tool use: ${toolUseContent.name}.`);

        // Extract tool parameters
        const toolInput = toolUseContent.input as any;

        // Execute the tool
        const toolResult = await this.textEditorTool.call({
          command: toolInput.command,
          path: toolInput.path || filePath,
          old_str: toolInput.old_str,
          new_str: toolInput.new_str,
          view_range: toolInput.view_range,
          insert_line: toolInput.insert_line,
          file_text: toolInput.file_text,
        });

        // Save the most recent tool result
        lastToolResult = toolResult;

        // If the tool made a change (not just a view), check if file is now valid
        if (
          toolInput.command === 'str_replace' ||
          toolInput.command === 'insert'
        ) {
          logger.info(
            CHANNEL,
            `Claude applied a fix with ${toolInput.command}`,
          );

          // Re-validate the file
          const newValidationResult = await validateFix(filePath);

          // Update the validation result for the next iteration
          validationResult = newValidationResult;

          // Check if file is now valid
          if (newValidationResult.isValid) {
            logger.info(
              CHANNEL,
              `File is now valid after ${currentIteration} iterations`,
            );
            isFixed = true;
          } else {
            logger.info(
              CHANNEL,
              `File still has issues after fix: ${JSON.stringify(newValidationResult.error)}`,
            );

            // Read updated content and get new error context
            content = await workspaceFileUtils.readFile(filePath);
            if (newValidationResult.error) {
              errorContext = getErrorContext(
                content,
                newValidationResult.error,
              );
            } else {
              // Default context if no error is provided
              errorContext = this.getDefaultContext(content);
            }
          }
        }

        // Add Claude's response and the tool result to the conversation
        messages.push({
          role: 'assistant' as const,
          content: [toolUseContent],
        } as any);

        messages.push({
          role: 'user' as const,
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseContent.id,
              content:
                toolResult.output || `Tool ${toolInput.command} executed.`,
            },
            {
              type: 'text',
              text: createFollowUpMessage(
                validationResult,
                isFixed,
                currentIteration,
              ),
            },
          ],
        } as any);
      }

      // Return the last tool result if we have one
      if (lastToolResult) {
        return lastToolResult;
      }

      // No action was taken by Claude
      logger.warn(
        CHANNEL,
        `Claude did not make any changes to fix the file after ${this.maxIterations} iterations`,
      );
      return new ToolResult({
        error: `Claude did not fix the file after ${this.maxIterations} iterations`,
        isError: true,
      });
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error calling Claude API: ${this.formatErrorMessage(err)}`,
      );

      return new ToolResult({
        error: `Error calling Claude API: ${String(err)}`,
        isError: true,
      });
    }
  }

  /**
   * Get content around an error line with specified number of lines before and after
   */
  protected getContentAroundLine(
    content: string,
    line: number,
    contextLines: number,
  ): string {
    const lines = content.split('\n');
    const start = Math.max(0, line - contextLines - 1);
    const end = Math.min(lines.length, line + contextLines);

    return lines
      .slice(start, end)
      .map((textLine, i) => {
        const lineNumber = start + i + 1;
        const marker = lineNumber === line ? '→ ' : '  ';
        return `${lineNumber.toString().padStart(4, ' ')}: ${marker}${textLine}`;
      })
      .join('\n');
  }

  /**
   * Format an error message consistently
   * This helps maintain a consistent error message format throughout the codebase
   */
  protected formatErrorMessage(err: unknown): string {
    return getSdkErrorMessage(err);
  }

  /**
   * Get default context from the beginning of the content
   * This is a fallback when line-specific context cannot be obtained
   */
  protected getDefaultContext(content: string): string {
    return content.split('\n').slice(0, this.contextLines).join('\n');
  }

  /**
   * Abstract method to validate a file and return validation results
   * Must be implemented by concrete classes
   */
  protected abstract validateFile(
    filePath: string,
  ): Promise<ValidationResult<ErrorType>>;

  /**
   * Abstract method to get context around an error
   * Must be implemented by concrete classes
   */
  protected abstract getErrorContext(content: string, error: ErrorType): string;

  /**
   * Abstract method to create system message for Claude
   * Must be implemented by concrete classes
   */
  protected abstract createSystemMessage(
    validationResult: ValidationResult<ErrorType>,
  ): string;

  /**
   * Abstract method to create initial user message for Claude
   * Must be implemented by concrete classes
   */
  protected abstract createInitialUserMessage(
    validationResult: ValidationResult<ErrorType>,
    filePath: string,
    errorContext: string,
  ): string;

  /**
   * Abstract method to create follow-up message for Claude
   * Must be implemented by concrete classes
   */
  protected abstract createFollowUpMessage(
    validationResult: ValidationResult<ErrorType>,
    isFixed: boolean,
    currentIteration: number,
  ): string;
}
