// Third-party imports
import type { Diagnostic } from 'vscode';
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import { ToolResult, ToolError, toolResult } from './result';
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

interface DiagnosticsPayload {
  path: string;
  command: DiagnosticsInput['command'];
  severity: DiagnosticsSeverityCounts;
  messages?: Diagnostic[];
}

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
          output: messages,
          severity,
          includeMessages: true,
        });
      case 'count':
        return this.createResult({
          command,
          path,
          summary: `Diagnostics count for ${path}`,
          output: severity,
          severity,
          includeMessages: false,
        });
      default:
        throw new ToolError(
          `Diagnostics tool error: Unrecognized command '${command}'. Expected 'list' or 'count'.`,
        );
    }
  }

  private async collectDiagnostics(path: string): Promise<{
    messages: Diagnostic[];
    severity: DiagnosticsSeverityCounts;
  }> {
    const messages = await getLinterMessages(path);
    const severity = countDiagnosticsBySeverity(messages);
    return { messages, severity };
  }

  private createResult({
    command,
    path,
    summary,
    output,
    severity,
    includeMessages,
  }: {
    command: DiagnosticsInput['command'];
    path: string;
    summary: string;
    output: DiagnosticsPayload['messages'] | DiagnosticsPayload['severity'];
    severity: DiagnosticsSeverityCounts;
    includeMessages: boolean;
  }): ToolResult {
    const payload: DiagnosticsPayload = {
      path,
      command,
      severity,
      messages: includeMessages ? (output as Diagnostic[]) : undefined,
    };

    return toolResult({
      summary,
      output: JSON.stringify(output, null, 2),
      diagnostics: payload,
    });
  }
}
