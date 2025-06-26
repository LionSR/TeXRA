// Standard library imports

// Third-party imports

// Local imports - core
import { BaseAnthropicTool, ToolError, ToolResult } from './base';
import { BetaToolUnionParam } from './types';

// Local imports - utils
import { getLinterMessages } from '@frontend/latex/linter';
import * as logger from '@logger/logUtils';

const CHANNEL = 'DiagnosticsTool';
logger.initialize(CHANNEL);

export type DiagnosticsCommand = 'list' | 'count';

export interface DiagnosticsToolInput {
  command: DiagnosticsCommand;
  path: string;
}

/**
 * Tool for retrieving VS Code diagnostics.
 */
export class DiagnosticsTool extends BaseAnthropicTool {
  toParams(): BetaToolUnionParam {
    return {
      name: 'diagnostics',
      type: 'custom',
      description:
        'Retrieve linter diagnostics. Use `list` for full messages or `count` for a summary.',
      input_schema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Either "list" or "count"',
            enum: ['list', 'count'],
          },
          path: { type: 'string', description: 'Relative file path' },
        },
        required: ['command', 'path'],
      },
    };
  }

  async call(input: DiagnosticsToolInput): Promise<ToolResult> {
    try {
      const { command, path } = input;
      if (!command || !path) {
        throw new ToolError('Both `command` and `path` are required');
      }

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
