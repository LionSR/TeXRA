// Standard library imports
import * as vscode from 'vscode';

// Third-party imports
import { XMLValidator } from 'fast-xml-parser';

// Local imports - core
import { AnthropicToolAgent } from './AnthropicToolAgent';

// Local imports - utils
import * as workspaceFileUtils from '../utils/workspaceFileUtils';

// Local imports - types
import { XMLValidationError, ValidationResult } from './types';

// Local imports - Logging
import * as logger from '../logger/logUtils';

/**
 * Agent that validates XML files and fixes validation errors using Claude
 */
export class XMLValidatorAgent extends AnthropicToolAgent<XMLValidationError> {
  /**
   * Static factory method to create an XMLValidatorAgent instance
   */
  public static create(): XMLValidatorAgent {
    return new XMLValidatorAgent();
  }

  /**
   * Validate XML file
   * Implementation of abstract method from base class
   */
  protected async validateFile(filePath: string): Promise<ValidationResult<XMLValidationError>> {
    try {
      // Read the file content
      const content = await workspaceFileUtils.readFile(filePath);

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
      logger.error(
        this.logChannel,
        `Error validating XML file: ${this.formatErrorMessage(err)}`,
      );

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
   * Get context around an error
   * Implementation of abstract method from base class
   */
  protected getErrorContext(content: string, error: XMLValidationError): string {
    try {
      const line = error?.line || 1;
      return this.getContentAroundLine(content, line, this.contextLines);
    } catch (err) {
      logger.warn(
        this.logChannel,
        `Error getting error context: ${this.formatErrorMessage(err)}`,
      );
      // Default to first few lines using base class method
      return this.getDefaultContext(content);
    }
  }

  /**
   * Create the system message for Claude with current validation error
   * Implementation of abstract method from base class
   */
  protected createSystemMessage(validationResult: ValidationResult<XMLValidationError>): string {
    if (validationResult.isValid) {
      return `You are an expert XML validator and fixer. The XML file is now valid. Confirm that there are no more issues to fix.`;
    }

    return `You are an expert XML validator and fixer. You will be given an XML file with validation errors.
Your task is to fix these errors while making minimal changes to the file.

Some rules:
- If there are bare closing tags such as '</latex_document>' or other similar ones with error message 'Expected closing tag 'root' (opened in line 1, col 1) instead of closing tag 'latex_document'. at line XXX', you should usually add the opening tag '<latex_document>' or at the appropriate place. For example, by looking at the content around the end of the scratchpad, such as </scratchpad>. This is preferred over directly removing the bare closing tags. This is because we usually reserve <latex_document> tags for wrapping the output latex document.

The error information is:
- Message: ${validationResult.error?.message || 'Unknown error'}
- ${validationResult.error?.line ? `Line: ${validationResult.error.line}` : 'Line: unknown'}

Use the text_editor tool to view and modify the file. First view the file to understand its structure,
then make targeted fixes using str_replace or insert operations.`;
  }

  /**
   * Create the initial user message for Claude with error details
   * Implementation of abstract method from base class
   */
  protected createInitialUserMessage(
    validationResult: ValidationResult<XMLValidationError>,
    filePath: string,
    errorContext: string,
  ): string {
    const errorMessage = validationResult.error?.message || 'Unknown error';
    const errorLine = validationResult.error?.line
      ? `The error is on line ${validationResult.error.line}.`
      : 'Line number is unknown.';

    return `I need to fix an XML validation error in the file ${filePath}.
      
Error details:
${errorMessage}
${errorLine}

Here is the context around the error:
\`\`\`xml
${errorContext}
\`\`\`

Use the text_editor tool to fix this specific error. Make the minimal changes needed to fix the issue.`;
  }

  /**
   * Create follow-up message based on current validation status
   * Implementation of abstract method from base class
   */
  protected createFollowUpMessage(
    validationResult: ValidationResult<XMLValidationError>,
    isFixed: boolean,
    currentIteration: number,
  ): string {
    if (isFixed) {
      return 'The XML is now valid! Thank you for fixing the error.';
    }

    if (currentIteration >= this.maxIterations) {
      return "We've reached the maximum number of iterations. Please make one final attempt to fix the XML.";
    }

    const errorMessage = validationResult.error?.message || 'Unknown error';
    const errorLine = validationResult.error?.line
      ? `Line: ${validationResult.error.line}`
      : 'Line: unknown';

    return `The XML still has a validation error:
Message: ${errorMessage}
${errorLine}

Please continue fixing the XML error.`;
  }
}
