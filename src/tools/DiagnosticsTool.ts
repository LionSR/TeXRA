// Third-party imports
import type { Diagnostic } from 'vscode';
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import {
  type DiagnosticsPayload,
  ToolResult,
  ToolError,
  toolResult,
} from './result';
import {
  getLinterMessages,
  countDiagnosticsBySeverity,
} from '@frontend/latex/linter';
import * as logger from '@logger/logUtils';

const CHANNEL = 'DiagnosticsTool';
logger.initialize(CHANNEL);

export const DiagnosticsInputSchema = z.object({
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
      const detail = error instanceof Error ? error.message : String(error);
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

    return toolResult({
      summary: args.summary,
      output: JSON.stringify(payload, null, 2),
      diagnostics: payload,
    });
  }
}
