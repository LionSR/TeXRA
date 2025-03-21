// Standard library imports
import * as vscode from 'vscode';

// Third-party imports
import { XMLValidator } from 'fast-xml-parser';

// Local imports - core
import { AnthropicToolAgent } from './AnthropicToolAgent';

// Local imports - utils
import { getConfig } from '../utils/configUtils';
import * as workspaceFileUtils from '../utils/workspaceFileUtils';

// Local imports - Logging
import * as logger from '../logger/logUtils';

const CHANNEL = 'XMLValidatorAgent';
logger.initialize(CHANNEL);

/**
 * Agent that validates XML files and fixes validation errors using Claude
 */
export class XMLValidatorAgent extends AnthropicToolAgent {
  /**
   * Validate an XML file and fix any errors found
   *
   * @param filePath Path to the XML file to validate and fix
   * @param maxIterations Maximum number of fix attempts
   * @returns Whether the validation and fixing was successful
   */
  async validateAndFix(
    filePath: string,
    maxIterations?: number,
  ): Promise<boolean> {
    logger.info(CHANNEL, `Starting XML validation and fixing for ${filePath}`);

    try {
      // Get maxIterations from configuration if not provided
      if (maxIterations === undefined) {
        maxIterations = getConfig('xmlValidator.maxIterations', 5);
      }

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
      const errorContext = this.getContentAroundLine(
        content,
        validationResult.error?.line || 1,
        10,
      );

      // Call Claude to fix the XML
      const fixResult = await this.callClaudeToFix(
        filePath,
        this.createInitialUserMessage(validationResult, filePath, errorContext),
        (validationResult) => this.createSystemMessage(validationResult),
        (validationResult, isFixed, currentIteration, maxIterations) =>
          this.createFollowUpMessage(
            validationResult,
            isFixed,
            currentIteration,
            maxIterations,
          ),
        (content) => this.validateXML(content),
        (content, error) =>
          this.getContentAroundLine(content, error?.line || 1, 10),
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

Some rules:
- If there are bare closing tags such as '</latex_document>' or other similar ones with error message 'Expected closing tag 'root' (opened in line 1, col 1) instead of closing tag 'latex_document'. at line XXX', you should usually add the opening tag '<latex_document>' or at the appropriate place. For example, by looking at the content around the end of the scratchpad, such as </scratchpad>. This is preferred over directly removing the bare closing tags. This is because we usually reserve <latex_document> tags for wrapping the output latex document.

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
}
