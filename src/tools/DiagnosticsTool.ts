// Third-party imports
import { z } from 'zod';

// Internal imports
import { toErrorMessage } from '@common/errors';
import {
  getLinterMessages,
  countDiagnosticsBySeverity,
} from '@frontend/latex/linter';
import * as logger from '@logger/logUtils';

// Local file imports
import { defineTool } from './core/define';
import { type DiagnosticsPayload, ToolResult, ToolError } from './result';

// Type imports
import type { Diagnostic } from 'vscode';

const CHANNEL = 'DiagnosticsTool';
logger.initialize(CHANNEL);

export const DiagnosticsInputSchema = z.strictObject({
  command: z.enum(['list', 'count']),
  path: z.string(),
});

export type DiagnosticsInput = z.infer<typeof DiagnosticsInputSchema>;

type DiagnosticsSeverityCounts = ReturnType<typeof countDiagnosticsBySeverity>;

export class DiagnosticsTool extends defineTool({
  name: 'diagnostics',
  description:
    'Retrieve linter diagnostics. Use "list" for full messages or "count" for a summary.',
  schema: DiagnosticsInputSchema,
}) {
  protected async execute(input: DiagnosticsInput): Promise<ToolResult> {
    const { command, path } = input;
    const { messages, severity } = await this.collectDiagnostics(path);

    switch (command) {
      case 'list':
        return this.createResult({
          command,
          path,
          summary: `Diagnostics list for ${path}`,
          severity,
          messages,
        });
      case 'count':
        return this.createResult({
          command,
          path,
          summary: `Diagnostics count for ${path}`,
          severity,
        });
      default:
        throw new ToolError(
          `Diagnostics tool error: Unrecognized command '${command}'. Expected 'list' or 'count'.`,
        );
    }
  }

  /**
   * Resolve diagnostics for a given path and compute their severity totals.
   */
  private async collectDiagnostics(path: string): Promise<{
    messages: Diagnostic[];
    severity: DiagnosticsSeverityCounts;
  }> {
    try {
      const messages = await getLinterMessages(path);
      const severity = countDiagnosticsBySeverity(messages);
      return { messages, severity };
    } catch (error) {
      const detail = toErrorMessage(error);
      logger.error(
        CHANNEL,
        `Failed to collect diagnostics for ${path}: ${detail}`,
      );
      throw new ToolError(`Failed to collect diagnostics: ${detail}`);
    }
  }

  /**
   * Wrap diagnostics data in the shared tool result format.
   */
  private createResult(
    args:
      | {
          command: 'list';
          path: string;
          summary: string;
          severity: DiagnosticsSeverityCounts;
          messages: Diagnostic[];
        }
      | {
          command: 'count';
          path: string;
          summary: string;
          severity: DiagnosticsSeverityCounts;
        },
  ): ToolResult {
    const payload: DiagnosticsPayload = {
      path: args.path,
      command: args.command,
      severity: args.severity,
      ...('messages' in args ? { messages: args.messages } : {}),
    };

    // Build human-readable output
    const { errors = 0, warnings = 0, info = 0, hints = 0 } = args.severity;
    const counts = [
      errors > 0 && `${errors} error${errors === 1 ? '' : 's'}`,
      warnings > 0 && `${warnings} warning${warnings === 1 ? '' : 's'}`,
      info > 0 && `${info} info`,
      hints > 0 && `${hints} hint${hints === 1 ? '' : 's'}`,
    ]
      .filter(Boolean)
      .join(', ');

    // For 'list' command, include actual diagnostic messages so model can see them
    // Always include file path so model knows which file diagnostics belong to
    let output: string;
    const header = `${args.path}: ${counts || 'No issues found'}`;
    if ('messages' in args && args.messages.length > 0) {
      const messageLines = args.messages.map((d) => {
        const line = d.range.start.line + 1; // VS Code lines are 0-indexed
        const severity =
          ['error', 'warning', 'info', 'hint'][d.severity] ?? 'unknown';
        return `  ${line}: [${severity}] ${d.message}`;
      });
      output = `${header}\n\n${messageLines.join('\n')}`;
    } else {
      output = header;
    }

    return {
      summary: args.summary,
      output,
      diagnostics: payload,
    };
  }
}
