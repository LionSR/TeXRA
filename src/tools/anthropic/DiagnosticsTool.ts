// Standard library imports

// Third-party imports

// Local imports - core
import { BaseAnthropicTool, ToolError, ToolResult } from './base';
import { BetaToolUnionParam } from './types';

// Local imports - utils
import {
  getLinterMessages,
  countDiagnosticsBySeverity,
} from '@frontend/latex/linter';
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
    return { name: 'diagnostics', type: 'diagnostics' };
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
          const counts = countDiagnosticsBySeverity(path);
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
