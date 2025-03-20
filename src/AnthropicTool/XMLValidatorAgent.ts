import * as vscode from 'vscode';
import { XMLValidator } from 'fast-xml-parser';
import Anthropic from '@anthropic-ai/sdk';
import { TextEditorTool } from './TextEditorTool';
import { ToolResult, CLIResult } from './base';
import * as workspaceFileUtils from '../utils/workspaceFileUtils';
import * as logger from '../logger/logUtils';
import {
  getApiKey as getSecretApiKey,
  ApiProvider,
} from '../utils/secretUtils';

const CHANNEL = 'XMLValidatorAgent';
logger.initialize(CHANNEL);

/**
 * Agent that validates XML files and fixes validation errors using Claude
 */
export class XMLValidatorAgent {
  private textEditorTool: TextEditorTool;
  private model: string = 'claude-3-7-sonnet-latest';

  constructor() {
    this.textEditorTool = new TextEditorTool('text_editor_20250124');
  }

  /**
   * Get Anthropic API key from secure storage
   */
  private async getApiKey(): Promise<string> {
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
   * Validate an XML file and fix any errors found
   *
   * @param filePath Path to the XML file to validate and fix
   * @param maxIterations Maximum number of fix attempts
   * @returns Whether the validation and fixing was successful
   */
  async validateAndFix(
    filePath: string,
    maxIterations: number = 5,
  ): Promise<boolean> {
    logger.info(CHANNEL, `Starting XML validation and fixing for ${filePath}`);

    try {
      // Verify the file exists before starting
      const fileExists = await workspaceFileUtils.fileExists(filePath);
      if (!fileExists) {
        logger.error(CHANNEL, `File does not exist: ${filePath}`);
        vscode.window.showErrorMessage(`File does not exist: ${filePath}`);
        return false;
      }

      // Do initial validation to check if XML is already valid
      const content = await workspaceFileUtils.readFile(filePath);
      const validationResult = this.validateXML(content);

      // If XML is already valid, no need to fix anything
      if (validationResult.isValid) {
        logger.info(CHANNEL, `XML is already valid in ${filePath}`);
        vscode.window.showInformationMessage(
          `XML is already valid in ${filePath}`,
        );
        return true;
      }

      // Log the validation error
      logger.warn(
        CHANNEL,
        `XML validation failed: ${validationResult.error?.message} at line ${validationResult.error?.line}`,
      );

      // Get the context around the error
      const errorContext = this.getContentAroundErrorLine(
        content,
        validationResult.error?.line || 1,
        10,
      );

      // Call Claude to fix the XML
      const fixResult = await this.callClaudeToFixXML(
        validationResult,
        content,
        filePath,
        errorContext,
        maxIterations,
      );

      // Final validation to check if all issues are fixed
      const finalContent = await workspaceFileUtils.readFile(filePath);
      const finalValidation = this.validateXML(finalContent);

      if (finalValidation.isValid) {
        logger.info(CHANNEL, `Successfully fixed XML in ${filePath}`);
        vscode.window.showInformationMessage(
          `Successfully fixed XML in ${filePath}`,
        );
        return true;
      } else {
        logger.warn(
          CHANNEL,
          `Could not completely fix XML: ${finalValidation.error?.message}`,
        );
        vscode.window.showErrorMessage(
          `Could not completely fix XML in ${filePath}. Remaining issues: ${finalValidation.error?.message}`,
        );
        return false;
      }
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error in validateAndFix: ${err instanceof Error ? err.message : String(err)}`,
      );
      vscode.window.showErrorMessage(`Error validating XML: ${String(err)}`);
      return false;
    }
  }

  /**
   * Validate XML content
   */
  private validateXML(content: string): {
    isValid: boolean;
    error?: {
      message: string;
      line?: number;
      code?: string;
      data?: any;
    };
  } {
    try {
      // Use fast-xml-parser's XMLValidator to validate the XML
      const validationResult = XMLValidator.validate(content, {
        allowBooleanAttributes: true,
      });

      // If validation passed, validationResult is true
      if (validationResult === true) {
        return { isValid: true };
      }

      // If validation failed, validationResult contains error info
      return {
        isValid: false,
        error: {
          message: validationResult.err.msg,
          line: validationResult.err.line,
          code: 'xml-validation-error',
          data: validationResult,
        },
      };
    } catch (err) {
      return {
        isValid: false,
        error: {
          message: `Error validating XML: ${String(err)}`,
          code: 'validation-exception',
        },
      };
    }
  }

  /**
   * Call Claude API to fix the XML error using the TextEditorTool
   */
  private async callClaudeToFixXML(
    validationResult: {
      isValid: boolean;
      error?: {
        message: string;
        line?: number;
        code?: string;
        data?: any;
      };
    },
    content: string,
    filePath: string,
    errorContext: string,
    maxIterations: number = 5,
  ): Promise<ToolResult> {
    try {
      // Get the API key for Anthropic
      const apiKey = await this.getApiKey();

      // Create Anthropic client
      const client = new Anthropic({ apiKey });

      // Initialize conversation
      let messages = [
        {
          role: 'user' as const,
          content: this.createInitialUserMessage(
            validationResult,
            filePath,
            errorContext,
          ),
        },
      ];

      // Maximum conversation turns to try
      let currentIteration = 0;
      let lastToolResult: ToolResult | null = null;
      let isFixed = false;

      // Continue the conversation until we fix the XML or reach max iterations
      while (currentIteration < maxIterations && !isFixed) {
        currentIteration++;
        logger.info(CHANNEL, `Iteration ${currentIteration}/${maxIterations}`);

        // Make the system message with current validation error
        const systemMessage = this.createSystemMessage(validationResult);

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

        // If the tool made a change (not just a view), check if XML is now valid
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

          // Re-validate the XML
          const newValidationResult = this.validateXML(updatedContent);

          // Update the validation result for the next iteration
          validationResult = newValidationResult;

          // Check if XML is now valid
          if (newValidationResult.isValid) {
            logger.info(
              CHANNEL,
              `XML is now valid after ${currentIteration} iterations`,
            );
            isFixed = true;
          } else {
            logger.info(
              CHANNEL,
              `XML still has issues after fix: ${newValidationResult.error?.message} at line ${newValidationResult.error?.line}`,
            );

            // Update the error context for the new error
            errorContext = this.getContentAroundErrorLine(
              updatedContent,
              newValidationResult.error?.line || 1,
              10,
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
              text: this.createFollowUpMessage(
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
        `Claude did not make any changes to fix the XML error after ${maxIterations} iterations`,
      );
      return new ToolResult({
        error: `Claude did not fix the XML error after ${maxIterations} iterations`,
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
   * Create the system message for Claude with current validation error
   */
  private createSystemMessage(validationResult: {
    isValid: boolean;
    error?: {
      message: string;
      line?: number;
    };
  }): string {
    if (validationResult.isValid) {
      return `You are an expert XML validator and fixer. The XML file is now valid. Confirm that there are no more issues to fix.`;
    }

    return `You are an expert XML validator and fixer. You will be given an XML file with validation errors.
Your task is to fix these errors while making minimal changes to the file.

The error information is:
- Message: ${validationResult.error?.message}
- Line: ${validationResult.error?.line}

Use the text_editor tool to view and modify the file. First view the file to understand its structure,
then make targeted fixes using str_replace or insert operations.`;
  }

  /**
   * Create the initial user message for Claude with error details
   */
  private createInitialUserMessage(
    validationResult: {
      isValid: boolean;
      error?: {
        message: string;
        line?: number;
      };
    },
    filePath: string,
    errorContext: string,
  ): string {
    return `I need to fix an XML validation error in the file ${filePath}.
      
Error details:
${validationResult.error?.message}
${validationResult.error?.line ? `The error is on line ${validationResult.error.line}.` : ''}

Here is the context around the error:
\`\`\`xml
${errorContext}
\`\`\`

Use the text_editor tool to fix this specific error. Make the minimal changes needed to fix the issue.`;
  }

  /**
   * Create follow-up message based on current validation status
   */
  private createFollowUpMessage(
    validationResult: {
      isValid: boolean;
      error?: {
        message: string;
        line?: number;
      };
    },
    isFixed: boolean,
    currentIteration: number,
    maxIterations: number,
  ): string {
    if (isFixed) {
      return 'The XML is now valid! Thank you for fixing the error.';
    }

    if (currentIteration >= maxIterations) {
      return "We've reached the maximum number of iterations. Please make one final attempt to fix the XML.";
    }

    return `The XML still has a validation error:
Message: ${validationResult.error?.message}
${validationResult.error?.line ? `Line: ${validationResult.error.line}` : ''}

Please continue fixing the XML error.`;
  }

  /**
   * Get content around an error line with specified number of lines before and after
   */
  private getContentAroundErrorLine(
    content: string,
    errorLine: number,
    contextLines: number,
  ): string {
    const lines = content.split('\n');
    const start = Math.max(0, errorLine - contextLines - 1);
    const end = Math.min(lines.length, errorLine + contextLines);

    return lines
      .slice(start, end)
      .map((line, i) => {
        const lineNumber = start + i + 1;
        const marker = lineNumber === errorLine ? '→ ' : '  ';
        return `${lineNumber.toString().padStart(4, ' ')}: ${marker}${line}`;
      })
      .join('\n');
  }
}
