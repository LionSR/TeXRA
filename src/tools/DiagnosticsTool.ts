// Third-party imports
import { z } from 'zod';

// Internal imports
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';

type LinterProvider = (path: string) => Promise<GenericDiagnostic[]>;
let linterProvider: LinterProvider = async () => [];
/** Inject the VS Code linter diagnostics provider. Default: returns empty. */
export function setLinterProvider(provider: LinterProvider): void {
  linterProvider = provider;
}
import {
  countBySeverity,
  formatCounts,
  formatMessageList,
} from '@utils/diagnostics/diagnosticFormatting';

// Local file imports
import { defineTool } from './core/define';
import { type ToolResult, ToolError } from './result';

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
      const messages = await linterProvider(path);
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
