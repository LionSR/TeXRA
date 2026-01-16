// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Internal imports
import { toErrorMessage } from '@common/errors';
import {
  countBySeverity,
  formatCounts,
  formatMessageList,
} from '@frontend/vscode/vscodeDiagnostics';
import { getLinterMessages } from '@frontend/latex/linter';
import * as logger from '@logger/logUtils';

// Local file imports
import { defineTool } from './core/define';
import { ToolResult, ToolError } from './result';

const CHANNEL = 'DiagnosticsTool';
logger.initialize(CHANNEL);

export const DiagnosticsInputSchema = z.strictObject({
  command: z.enum(['list', 'count']),
  path: z.string(),
});

export type DiagnosticsInput = z.infer<typeof DiagnosticsInputSchema>;

export class DiagnosticsTool extends defineTool({
  name: 'diagnostics',
  description:
    'Retrieve linter diagnostics. Use "list" for full messages or "count" for a summary.',
  schema: DiagnosticsInputSchema,
}) {
  protected async execute(input: DiagnosticsInput): Promise<ToolResult> {
    const { command, path } = input;

    try {
      const messages = await getLinterMessages(path);
      const counts = countBySeverity(messages);
      const header = `${path}: ${formatCounts(counts)}`;
      const summary = `Diagnostics ${command} for ${path}`;

      const baseDiagnostics = {
        path,
        command,
        severity: counts,
      };

      if (command === 'count') {
        return { summary, output: header, diagnostics: baseDiagnostics };
      }

      const messageDetails =
        messages.length > 0 ? `\n\n${formatMessageList(messages)}` : '';
      return {
        summary,
        output: `${header}${messageDetails}`,
        diagnostics: { ...baseDiagnostics, messages },
      };
    } catch (error) {
      const detail = toErrorMessage(error);
      logger.error(
        CHANNEL,
        `Failed to collect diagnostics for ${path}: ${detail}`,
      );
      throw new ToolError(`Failed to collect diagnostics: ${detail}`);
    }
  }
}
