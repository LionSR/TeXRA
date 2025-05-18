// Standard library imports - (none)

// Local imports - core
import { AnthropicToolAgent } from './AnthropicToolAgent';
import { ToolResult } from './base';

// Local imports - types
import { ValidationResult } from './types';
import { LinterMessage } from '../utils/linterUtils';

// Local imports - utils
import * as workspaceFileUtils from '../utils/workspaceFileUtils';
import * as linterUtils from '../utils/linterUtils';

// Local imports - Logging
import * as logger from '../logger/logUtils';

const CHANNEL = 'TeXLinterFixAgent';
logger.initialize(CHANNEL);

/**
 * Agent that fixes linter issues in TeX files using Claude
 */
export class TeXLinterFixAgent extends AnthropicToolAgent<LinterMessage[]> {
  /**
   * Validate if the file has any linter issues
   * Implementation of abstract method from base class
   */
  protected async validateFile(
    filePath: string,
  ): Promise<ValidationResult<LinterMessage[]>> {
    try {
      // Get diagnostics - getLinterMessages now handles build triggering
      const issues = await linterUtils.getLinterMessages(filePath);

      // Log raw linter issues for debugging
      logger.debug(
        CHANNEL,
        `Linter issues raw data: ${JSON.stringify(issues)}`,
      );

      if (!issues || issues.length === 0) {
        return { isValid: true };
      }

      return {
        isValid: false,
        error: issues as LinterMessage[],
      };
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error validating linter fixes: ${this.formatErrorMessage(err)}`,
      );
      return {
        isValid: false,
        error: [], // Return empty array instead of undefined on error
      };
    }
  }

  /**
   * Get context around the error for Claude
   * Implementation of abstract method from base class
   */
  protected getErrorContext(content: string, issues: LinterMessage[]): string {
    // Ensure issues is always an array
    const issuesArray = Array.isArray(issues) ? issues : issues ? [issues] : [];

    if (!issuesArray.length) {
      return 'No issues found.';
    }

    // Get the first issue with a line number, or default to line 1
    let errorLine = 1;
    for (const issue of issuesArray) {
      if (issue && typeof issue.line === 'number' && issue.line > 0) {
        errorLine = issue.line;
        break;
      }
    }

    // Get context around the error line
    try {
      return this.getContentAroundLine(content, errorLine, this.contextLines);
    } catch (err) {
      logger.warn(
        CHANNEL,
        `Error getting error context: ${this.formatErrorMessage(err)}`,
      );
      // Default to first few lines using base class method
      return this.getDefaultContext(content);
    }
  }

  /**
   * Create system message for Claude with current linter issues
   * Implementation of abstract method from base class
   */
  protected createSystemMessage(
    validation: ValidationResult<LinterMessage[]>,
  ): string {
    // Ensure issues is always an array
    const issuesArray = validation.error || [];

    if (!issuesArray.length) {
      return `You are an expert in fixing linter issues. The file is now free of linter issues. Confirm that there are no more issues to fix.`;
    }

    const errorsByType = this.groupIssuesByType(issuesArray);

    return `You are an expert at fixing linter issues. You will be given a file with linter issues.
Your task is to fix these issues while making minimal changes to the file.

Here's a summary of the issues:
${Object.entries(errorsByType)
  .map(([type, count]) => `- ${count} issues of type: ${type}`)
  .join('\n')}

Use the text_editor tool to view and modify the file. First view the file to understand its structure,
then make targeted fixes using str_replace or insert operations.`;
  }

  /**
   * Create the initial user message for Claude with error details
   * Implementation of abstract method from base class
   */
  protected createInitialUserMessage(
    validation: ValidationResult<LinterMessage[]>,
    filePath: string,
    errorContext: string,
  ): string {
    // Ensure issues is always an array
    const issuesArray = validation.error || [];

    const firstFewIssues = issuesArray
      .slice(0, 5)
      .map((issue) => {
        // Defensive handling for issue properties
        const severity = issue?.severity || 'UNKNOWN';
        const source = issue?.source || 'unknown';
        const line = issue?.line || '?';
        const column = issue?.column || '?';
        const message = issue?.message || 'Unknown issue';

        return `${severity.toUpperCase()} [${source}]: Line ${line}, Col ${column} - ${message}`;
      })
      .join('\n');

    return `I need to fix linter issues in the file ${filePath}.
      
There are ${issuesArray.length} issues in total. Here are the first few:
${firstFewIssues}

Here is the context around the first issue:
\`\`\`${errorContext}
\`\`\`

Use the text_editor tool to fix these issues. Make the minimal changes needed to fix the linter problems.`;
  }

  /**
   * Create follow-up message based on current linter status
   * Implementation of abstract method from base class
   */
  protected createFollowUpMessage(
    validation: ValidationResult<LinterMessage[]>,
    isFixed: boolean,
    currentIteration: number,
  ): string {
    if (isFixed) {
      return 'All linter issues are now fixed! Thank you.';
    }

    if (currentIteration >= this.maxIterations) {
      return "We've reached the maximum number of iterations. Please make one final attempt to fix the remaining issues.";
    }

    // Ensure issues is always an array
    const issuesArray = validation.error || [];

    const remainingIssuesCount = issuesArray.length;
    const firstFew = issuesArray
      .slice(0, 3)
      .map((issue) => {
        // Defensive handling for issue properties
        const severity = issue?.severity || 'UNKNOWN';
        const source = issue?.source || 'unknown';
        const line = issue?.line || '?';
        const column = issue?.column || '?';
        const message = issue?.message || 'Unknown issue';

        return `${severity.toUpperCase()} [${source}]: Line ${line}, Col ${column} - ${message}`;
      })
      .join('\n');

    return `There are still ${remainingIssuesCount} linter issues. Here are the first few:
${firstFew}

Please continue fixing the linter issues.`;
  }

  /**
   * Group issues by type for better summary
   */
  private groupIssuesByType(issues: LinterMessage[]): Record<string, number> {
    const result: Record<string, number> = {};

    for (const issue of issues) {
      const type = issue.source || 'unknown';
      if (result[type]) {
        result[type]++;
      } else {
        result[type] = 1;
      }
    }

    return result;
  }
}
