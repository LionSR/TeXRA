// Third-party imports
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

export class DiagnosticsTool extends defineTool({
  name: 'diagnostics',
  description:
    'Retrieve linter diagnostics. Use "list" for full messages or "count" for a summary.',
  schema: DiagnosticsInputSchema,
}) {
  protected async execute(input: DiagnosticsInput): Promise<ToolResult> {
    const { command, path } = input;
    switch (command) {
      case 'list': {
        const messages = await getLinterMessages(path);
        return toolResult({
          summary: `Diagnostics list for ${path}`,
          output: JSON.stringify(messages),
        });
      }
      case 'count': {
        const messages = await getLinterMessages(path);
        const counts = countDiagnosticsBySeverity(messages);
        return toolResult({
          summary: `Diagnostics count for ${path}`,
          output: JSON.stringify(counts),
        });
      }
      default:
        throw new ToolError(
          `Diagnostics tool error: Unrecognized command '${command}'. Expected 'list' or 'count'.`,
        );
    }
  }
}
