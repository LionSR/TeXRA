// Third-party imports
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Local imports - tools
import { BaseTool } from './core/base';
import { ToolResult, ToolError } from './result';
import {
  getLinterMessages,
  countDiagnosticsBySeverity,
} from '@frontend/latex/linter';
import * as logger from '@logger/logUtils';
import type { ToolDefinition } from '@model';

const CHANNEL = 'DiagnosticsTool';
logger.initialize(CHANNEL);

export const DiagnosticsInputSchema = z.object({
  command: z.enum(['list', 'count']),
  path: z.string(),
});

export type DiagnosticsInput = z.infer<typeof DiagnosticsInputSchema>;

export class DiagnosticsTool extends BaseTool<DiagnosticsInput> {
  constructor() {
    const definition: ToolDefinition = {
      name: 'diagnostics',
      description:
        'Retrieve linter diagnostics. Use "list" for full messages or "count" for a summary.',
      parameters: zodToJsonSchema(DiagnosticsInputSchema),
    };
    super(definition, DiagnosticsInputSchema);
  }

  protected async execute(input: DiagnosticsInput): Promise<ToolResult> {
    const { command, path } = input;
    switch (command) {
      case 'list': {
        const messages = await getLinterMessages(path);
        return new ToolResult({ output: JSON.stringify(messages) });
      }
      case 'count': {
        const messages = await getLinterMessages(path);
        const counts = countDiagnosticsBySeverity(messages);
        return new ToolResult({ output: JSON.stringify(counts) });
      }
      default:
        throw new ToolError(`Diagnostics tool error: Unrecognized command '${command}'. Expected 'list' or 'count'.`);
    }
  }
}
