import { z } from 'zod';
import { getLinterMessages } from '@frontend/latex/linter';
import * as logger from '@logger/logUtils';
import { BaseTool } from './core/base';
import { ToolResult, ToolError } from './result';
import type { ToolDefinition } from '@model';
import { zodToJsonSchema } from 'openai/_vendor/zod-to-json-schema/index.js';

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
      parameters: zodToJsonSchema(DiagnosticsInputSchema, {
        name: 'diagnosticsInput',
      }),
    };
    super(definition, DiagnosticsInputSchema);
  }

  protected async execute(input: DiagnosticsInput): Promise<ToolResult> {
    try {
      const { command, path } = input;
      switch (command) {
        case 'list': {
          const messages = await getLinterMessages(path);
          return new ToolResult({ output: JSON.stringify(messages) });
        }
        case 'count': {
          const messages = await getLinterMessages(path);
          const counts = { errors: 0, warnings: 0, info: 0, hints: 0 };
          messages.forEach((m) => {
            switch (m.severity) {
              case 'error':
                counts.errors++;
                break;
              case 'warning':
                counts.warnings++;
                break;
              case 'info':
                counts.info++;
                break;
              case 'hint':
                counts.hints++;
                break;
            }
          });
          return new ToolResult({ output: JSON.stringify(counts) });
        }
        default:
          throw new ToolError(`Unrecognized command: ${command}`);
      }
    } catch (err) {
      if (err instanceof ToolError) {
        return new ToolResult({ error: err.message, isError: true });
      }
      return new ToolResult({ error: String(err), isError: true });
    }
  }
}
