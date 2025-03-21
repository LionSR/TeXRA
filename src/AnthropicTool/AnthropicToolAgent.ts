// Standard library imports
import * as vscode from 'vscode';

// Third-party imports
import Anthropic from '@anthropic-ai/sdk';

// Local imports
import { TextEditorTool } from './TextEditorTool';
import { ToolResult } from './base';
import * as workspaceFileUtils from '../utils/workspaceFileUtils';
import {
  getApiKey as getSecretApiKey,
  ApiProvider,
} from '../utils/secretUtils';
import * as logger from '../logger/logUtils';
import { getConfig } from '../utils/configUtils';

const CHANNEL = 'AnthropicToolAgent';
logger.initialize(CHANNEL);

/**
 * Abstract base class for agents that use Claude to fix issues in files
 */
export abstract class AnthropicToolAgent {
  protected textEditorTool: TextEditorTool;
  protected model: string = 'claude-3-7-sonnet-latest';

  constructor() {
    this.textEditorTool = new TextEditorTool('text_editor_20250124');
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
        `Error getting Anthropic API key: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new Error(
        'Anthropic API key not found. Please set it using the "Set API Key" command.',
      );
    }
  }

  /**
   * Call Claude API to fix issues in a file
   */
  protected async callClaudeToFix(
    filePath: string,
    initialUserMessage: string,
    createSystemMessage: (errorInfo: any) => string,
    createFollowUpMessage: (
      errorInfo: any,
      isFixed: boolean,
      currentIteration: number,
      maxIterations: number,
    ) => string,
    validateFix: (
      content: string,
    ) =>
      | Promise<{ isValid: boolean; error?: any }>
      | { isValid: boolean; error?: any },
    getErrorContext: (content: string, error: any) => string,
    maxIterations: number,
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

      // Read initial file content
      let content = await workspaceFileUtils.readFile(filePath);

      // Initial validation
      let validationResult = await this.runValidation(content, validateFix);

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

      // Get initial error context
      let errorContext = getErrorContext(content, validationResult.error);

      // Initialize conversation
      let messages = [
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
      while (currentIteration < maxIterations && !isFixed) {
        currentIteration++;
        logger.info(CHANNEL, `Iteration ${currentIteration}/${maxIterations}`);

        // Make the system message with current validation error
        const systemMessage = createSystemMessage(validationResult);

        // Call Claude API
        const response = await client.messages.create({
          model: this.model,
          max_tokens: 1024,
          system: systemMessage,
          messages,
          tools: [
            {
              type: 'text_editor_20250124' as const,
              name: 'str_replace_editor',
            },
          ],
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

          // Re-read the file content after the change
          const updatedContent = await workspaceFileUtils.readFile(filePath);

          // Re-validate the file
          const newValidationResult = await this.runValidation(
            updatedContent,
            validateFix,
          );

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

            // Update the error context for the new error
            errorContext = getErrorContext(
              updatedContent,
              newValidationResult.error,
            );
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
                maxIterations,
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
        `Claude did not make any changes to fix the file after ${maxIterations} iterations`,
      );
      return new ToolResult({
        error: `Claude did not fix the file after ${maxIterations} iterations`,
        isError: true,
      });
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error calling Claude API: ${err instanceof Error ? err.message : String(err)}`,
      );

      return new ToolResult({
        error: `Error calling Claude API: ${String(err)}`,
        isError: true,
      });
    }
  }

  /**
   * Helper to handle both sync and async validation functions
   */
  private async runValidation(
    content: string,
    validateFix: (
      content: string,
    ) =>
      | Promise<{ isValid: boolean; error?: any }>
      | { isValid: boolean; error?: any },
  ): Promise<{ isValid: boolean; error?: any }> {
    const result = validateFix(content);
    if (result instanceof Promise) {
      return await result;
    }
    return result;
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
}
