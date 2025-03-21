// Standard library imports
import * as vscode from 'vscode';

// Local imports
import { AnthropicToolAgent } from './AnthropicToolAgent';
import { ToolResult } from './base';
import * as workspaceFileUtils from '../utils/workspaceFileUtils';
import * as linterUtils from '../utils/linterUtils';
import * as logger from '../logger/logUtils';
import { getConfig } from '../utils/configUtils';

const CHANNEL = 'TeXLinterFixAgent';
logger.initialize(CHANNEL);

/**
 * Agent that fixes linter issues in TeX files using Claude
 */
export class TeXLinterFixAgent extends AnthropicToolAgent {
  /**
   * Fix linter issues in a file
   *
   * @param filePath Path to the file to fix linter issues
   * @param maxIterations Maximum number of fix attempts
   * @returns Whether the fixing was successful
   */
  async fixLinterIssues(
    filePath: string,
    maxIterations?: number,
  ): Promise<boolean> {
    logger.info(CHANNEL, `Starting linter issue fixing for ${filePath}`);

    try {
      // Get maxIterations from configuration if not provided
      if (maxIterations === undefined) {
        maxIterations = getConfig('linterFixer.maxIterations', 5);
      }

      // Verify the file exists before starting
      const fileExists = await workspaceFileUtils.fileExists(filePath);
      if (!fileExists) {
        logger.error(CHANNEL, `File does not exist: ${filePath}`);
        vscode.window.showErrorMessage(`File does not exist: ${filePath}`);
        return false;
      }

      // Get initial linter issues
      const initialLinterIssues = linterUtils.getLinterMessages(filePath);

      // Log raw linter issues for debugging
      logger.debug(
        CHANNEL,
        `Linter issues raw data: ${JSON.stringify(initialLinterIssues)}`,
      );

      // If no issues found, no need to fix anything
      if (!initialLinterIssues || initialLinterIssues.length === 0) {
        logger.info(CHANNEL, `No linter issues found in ${filePath}`);
        vscode.window.showInformationMessage(
          `No linter issues found in ${filePath}`,
        );
        return true;
      }

      // Log the linter issues
      logger.warn(
        CHANNEL,
        `Found ${initialLinterIssues.length} linter issues in ${filePath}`,
      );

      // Read file content
      const content = await workspaceFileUtils.readFile(filePath);

      // Get the context around the first error
      let errorContext = '';
      try {
        errorContext = this.getContentAroundLine(
          content,
          initialLinterIssues[0]?.line || 1,
          10,
        );
      } catch (err) {
        logger.warn(
          CHANNEL,
          `Error getting context around line: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Default context - first 10 lines of the file
        errorContext = content.split('\n').slice(0, 10).join('\n');
      }

      // Call Claude to fix the issues
      const fixResult = await this.callClaudeToFix(
        filePath,
        this.createInitialUserMessage(
          initialLinterIssues,
          filePath,
          errorContext,
        ),
        (issues) => this.createSystemMessage(issues),
        (issues, isFixed, currentIteration, maxIterations) =>
          this.createFollowUpMessage(
            issues,
            isFixed,
            currentIteration,
            maxIterations,
          ),
        async (content) => this.validateFixes(filePath),
        (content, issues) => this.getErrorContext(content, issues),
        maxIterations,
      );

      // Final validation to check if all issues are fixed
      const finalIssues = linterUtils.getLinterMessages(filePath);

      if (!finalIssues || finalIssues.length === 0) {
        logger.info(
          CHANNEL,
          `Successfully fixed all linter issues in ${filePath}`,
        );
        vscode.window.showInformationMessage(
          `Successfully fixed all linter issues in ${filePath}`,
        );
        return true;
      } else {
        const initialCount = Array.isArray(initialLinterIssues)
          ? initialLinterIssues.length
          : 0;
        const finalCount = Array.isArray(finalIssues) ? finalIssues.length : 0;

        logger.warn(
          CHANNEL,
          `Could not fix all linter issues. Remaining: ${finalCount}`,
        );
        vscode.window.showInformationMessage(
          `Reduced linter issues from ${initialCount} to ${finalCount} in ${filePath}`,
        );
        return initialCount > finalCount; // Return true if we made some progress
      }
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error in fixLinterIssues: ${err instanceof Error ? err.message : String(err)}`,
      );
      vscode.window.showErrorMessage(
        `Error fixing linter issues: ${String(err)}`,
      );
      return false;
    }
  }

  /**
   * Validate if the file has any linter issues
   */
  private async validateFixes(filePath: string): Promise<{
    isValid: boolean;
    error?: any;
  }> {
    try {
      const issues = linterUtils.getLinterMessages(filePath);

      if (issues.length === 0) {
        return { isValid: true };
      }

      return {
        isValid: false,
        error: issues,
      };
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error validating linter fixes: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        isValid: false,
        error: [], // Return empty array instead of undefined on error
      };
    }
  }

  /**
   * Get context around the error for Claude
   */
  private getErrorContext(content: string, issues: any): string {
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
    return this.getContentAroundLine(content, errorLine, 10);
  }

  /**
   * Create system message for Claude with current linter issues
   */
  private createSystemMessage(issues: any): string {
    // Ensure issues is always an array
    const issuesArray = Array.isArray(issues) ? issues : issues ? [issues] : [];

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
   */
  private createInitialUserMessage(
    issues: any,
    filePath: string,
    errorContext: string,
  ): string {
    // Ensure issues is always an array
    const issuesArray = Array.isArray(issues) ? issues : issues ? [issues] : [];

    const firstFewIssues = issuesArray
      .slice(0, 5)
      .map((issue) => {
        // Defensive handling for issue properties
        const severity = issue?.severity
          ? issue.severity.toUpperCase()
          : 'UNKNOWN';
        const source = issue?.source || 'unknown';
        const line = issue?.line || '?';
        const column = issue?.column || '?';
        const message = issue?.message || 'Unknown issue';

        return `${severity} [${source}]: Line ${line}, Col ${column} - ${message}`;
      })
      .join('\n');

    return `I need to fix linter issues in the file ${filePath}.
      
There are ${issuesArray.length} issues in total. Here are the first few:
${firstFewIssues}

Here is the context around the first issue:
\`\`\`
${errorContext}
\`\`\`

Use the text_editor tool to fix these issues. Make the minimal changes needed to fix the linter problems.`;
  }

  /**
   * Create follow-up message based on current linter status
   */
  private createFollowUpMessage(
    issues: any,
    isFixed: boolean,
    currentIteration: number,
    maxIterations: number,
  ): string {
    if (isFixed) {
      return 'All linter issues are now fixed! Thank you.';
    }

    if (currentIteration >= maxIterations) {
      return "We've reached the maximum number of iterations. Please make one final attempt to fix the remaining issues.";
    }

    // Ensure issues is always an array
    const issuesArray = Array.isArray(issues) ? issues : issues ? [issues] : [];

    const remainingIssuesCount = issuesArray.length;
    const firstFew = issuesArray
      .slice(0, 3)
      .map((issue) => {
        // Defensive handling for issue properties
        const severity = issue?.severity
          ? issue.severity.toUpperCase()
          : 'UNKNOWN';
        const source = issue?.source || 'unknown';
        const line = issue?.line || '?';
        const column = issue?.column || '?';
        const message = issue?.message || 'Unknown issue';

        return `${severity} [${source}]: Line ${line}, Col ${column} - ${message}`;
      })
      .join('\n');

    return `There are still ${remainingIssuesCount} linter issues. Here are the first few:
${firstFew}

Please continue fixing the linter issues.`;
  }

  /**
   * Group issues by type for better summary
   */
  private groupIssuesByType(issues: any[]): Record<string, number> {
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
