// Standard library imports
import * as vscode from 'vscode';

// Third-party imports
import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';

// Local imports - error utils
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';

// Local imports - core
import { TextEditorTool } from '@tools/anthropic/TextEditorTool';
import { DiagnosticsTool } from '@tools/anthropic/DiagnosticsTool';
import { ToolResult } from '@tools/anthropic/base';
import {
  BaseError,
  ValidationResult,
  BetaToolUnionParam,
} from '@tools/anthropic/types';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';
import { SecretManager, ApiProvider } from '@frontend/secretManager';
import { getConfig } from '@utils/config';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@common/errors/errorHandlingUtils';

// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

/**
 * Abstract base class for agents that use Claude to fix issues in files
 */
export abstract class BaseToolUseAgent<
  ErrorType extends BaseError | BaseError[],
> {
  // Constants used throughout the class
  protected static readonly MAX_ALLOWED_ITERATIONS: number = 20;
  protected static readonly DEFAULT_ITERATIONS: number = 10;
  protected static readonly DEFAULT_CONTEXT_LINES: number = 10;
  protected static readonly DEFAULT_MAX_TOKENS: number = 1024;

  protected textEditorTool: TextEditorTool;
  protected diagnosticsTool: DiagnosticsTool;
  protected configuredTools: string[] = ['text_editor'];
  protected model: string = 'claude-3-7-sonnet-latest';
  protected readonly agentName: string;
  protected readonly configKey: string;
  protected readonly logger: AgentLogger;
  protected maxIterations: number = BaseToolUseAgent.DEFAULT_ITERATIONS;
  protected contextLines: number = BaseToolUseAgent.DEFAULT_CONTEXT_LINES;
  protected maxTokens: number = BaseToolUseAgent.DEFAULT_MAX_TOKENS;

  constructor() {
    // Use different text editor tool for Claude 4 models vs older models
    const isClaude4Model =
      this.model.includes('claude-opus-4') ||
      this.model.includes('claude-sonnet-4');
    const textEditorType = isClaude4Model
      ? 'text_editor_20250429'
      : 'text_editor_20250124';
    this.textEditorTool = new TextEditorTool(textEditorType);
    this.diagnosticsTool = new DiagnosticsTool();

    // Derive agent name from class name
    this.agentName = this.constructor.name;

    // Remove 'Agent' suffix if present and convert to camelCase for config key
    const baseName = this.agentName.replace(/Agent$/, '');
    this.configKey = `${baseName.charAt(0).toLowerCase() + baseName.slice(1)}.maxIterations`;

    // Initialize logger with agent name
    this.logger = new AgentLogger(this.agentName, true);

    // Initialize maxIterations from config
    this.maxIterations = getConfig(
      this.configKey,
      BaseToolUseAgent.DEFAULT_ITERATIONS,
    );
  }

  /**
   * Set the list of tools allowed for this agent.
   */
  public setConfiguredTools(tools: string[]): void {
    if (Array.isArray(tools) && tools.length > 0) {
      this.configuredTools = tools;
    }
  }

  /**
   * Get tool parameters for the current configuration.
   */
  protected getConfiguredToolParams(): BetaToolUnionParam[] {
    const params: BetaToolUnionParam[] = [];
    for (const name of this.configuredTools) {
      if (name === 'text_editor') {
        params.push(this.textEditorTool.toParams() as any);
      } else if (name === 'diagnostics') {
        params.push(this.diagnosticsTool.toParams() as any);
      }
    }
    return params;
  }

  /**
   * Fix issues in the specified file.
   *
   * @param filePath Path to the file to fix
   * @returns Whether the fixing was successful
   */
  public async fixIssues(filePath: string): Promise<boolean> {
    this.logger.info(`Starting issue fixing for ${filePath}`);

    try {
      // Verify the file exists before starting
      const fileExists = await WorkspaceFS.exists(filePath);
      if (!fileExists) {
        await showLoggedMessage(
          this.logger.channelId,
          `File does not exist: ${filePath}`,
        );
        return false;
      }

      // Initial validation
      const validationResult = await this.validateFile(filePath);

      // Log validation result for debugging
      this.logger.debug(
        `Validation result: ${JSON.stringify(validationResult)}`,
      );

      // If content is already valid, no need to fix anything
      if (validationResult.isValid) {
        this.logger.info(`No issues found in ${filePath}`);
        vscode.window.showInformationMessage(`No issues found in ${filePath}`);
        return true;
      }

      // Log the issues
      this.logger.warn(
        `Validation failed: ${JSON.stringify(validationResult.error)}`,
      );

      // Read file content for context
      const content = await WorkspaceFS.readFile(filePath);

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
        this.logger.info(`Successfully fixed all issues in ${filePath}`);
        vscode.window.showInformationMessage(
          `Successfully fixed all issues in ${filePath}`,
        );
        return true;
      } else {
        this.logger.warn(
          `Could not fix all issues. Remaining: ${JSON.stringify(finalValidation.error)}`,
        );
        await showLoggedMessage(
          this.logger.channelId,
          `Could not fix all issues in ${filePath}. See log for details.`,
        );
        return false;
      }
    } catch (err) {
      await showLoggedErrorMessage(
        this.logger.channelId,
        'Error in fixIssues',
        err,
      );
      return false;
    }
  }

  /**
   * Get Anthropic API key from secure storage
   */
  protected async getApiKey(): Promise<string> {
    try {
      return await SecretManager.getApiKey('anthropic' as ApiProvider);
    } catch (err) {
      this.logger.error(
        `Error getting Anthropic API key: ${getSdkErrorMessage(err)}`,
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
      const fileExists = await WorkspaceFS.exists(filePath);
      if (!fileExists) {
        await showLoggedMessage(
          this.logger.channelId,
          `File does not exist: ${filePath}`,
        );
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
        this.logger.info(`File is already valid: ${filePath}`);
        vscode.window.showInformationMessage(
          `File is already valid: ${filePath}`,
        );
        return new ToolResult({
          output: 'File is already valid',
          isError: false,
        });
      }

      // Read file content for error context
      let content = await WorkspaceFS.readFile(filePath);

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
        this.logger.info(`Iteration ${currentIteration}/${this.maxIterations}`);

        // Make the system message with current validation error
        const systemMessage = createSystemMessage(validationResult);

        // Call Claude API
        const params: MessageCreateParams = {
          model: this.model,
          max_tokens: this.maxTokens,
          system: systemMessage,
          messages,
          tools: this.getConfiguredToolParams() as any,
        };
        const response: any = await client.messages.create(params);

        this.logger.debug(
          `Claude response (iteration ${currentIteration}): ${JSON.stringify(response)}`,
        );

        // Process tool use in Claude's response
        const toolUseContent = response.content.find(
          (c: any) => c.type === 'tool_use',
        );
        if (!toolUseContent || toolUseContent.type !== 'tool_use') {
          this.logger.warn(
            `Claude didn't use any tools in iteration ${currentIteration}`,
          );
          break;
        }

        this.logger.info(`Processing tool use: ${toolUseContent.name}.`);

        // Extract tool parameters
        const toolInput = toolUseContent.input as any;

        // Execute the appropriate tool based on name
        let toolResult: ToolResult;
        if (toolUseContent.name === this.textEditorTool.toParams().name) {
          toolResult = await this.textEditorTool.call({
            command: toolInput.command,
            path: toolInput.path || filePath,
            old_str: toolInput.old_str,
            new_str: toolInput.new_str,
            view_range: toolInput.view_range,
            insert_line: toolInput.insert_line,
            file_text: toolInput.file_text,
          });
        } else if (
          toolUseContent.name === this.diagnosticsTool.toParams().name
        ) {
          toolResult = await this.diagnosticsTool.call({
            command: toolInput.command,
            path: toolInput.path || filePath,
          });
        } else {
          this.logger.warn(`Unknown tool: ${toolUseContent.name}`);
          toolResult = new ToolResult({
            error: `Unknown tool: ${toolUseContent.name}`,
            isError: true,
          });
        }

        // Save the most recent tool result
        lastToolResult = toolResult;

        // If the tool made a change (not just a view), check if file is now valid
        if (
          toolInput.command === 'str_replace' ||
          toolInput.command === 'insert'
        ) {
          this.logger.info(`Claude applied a fix with ${toolInput.command}`);

          // Re-validate the file
          const newValidationResult = await validateFix(filePath);

          // Update the validation result for the next iteration
          validationResult = newValidationResult;

          // Check if file is now valid
          if (newValidationResult.isValid) {
            this.logger.info(
              `File is now valid after ${currentIteration} iterations`,
            );
            isFixed = true;
          } else {
            this.logger.info(
              `File still has issues after fix: ${JSON.stringify(newValidationResult.error)}`,
            );

            // Read updated content and get new error context
            content = await WorkspaceFS.readFile(filePath);
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
      this.logger.warn(
        `Claude did not make any changes to fix the file after ${this.maxIterations} iterations`,
      );
      return new ToolResult({
        error: `Claude did not fix the file after ${this.maxIterations} iterations`,
        isError: true,
      });
    } catch (err) {
      this.logger.error(`Error calling Claude API: ${getSdkErrorMessage(err)}`);

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
