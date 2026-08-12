// Third-party imports
import { z } from 'zod';

// Local imports
import { currentSession } from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';
import type { ToolDefinition } from '@model/ToolDefinition';
import { type ToolResult, ToolError } from '@shared/schemas/toolResult';
import {
  currentToolRoot,
  resolveWorkspaceRelativePath,
} from '@tools/pathResolution';
import { executed } from '@tools/core/result';
import {
  countBySeverity,
  formatCounts,
  formatMessageList,
} from '@utils/diagnostics/diagnosticFormatting';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { defineTool, toToolParameters } from './core/define';

const log = createLog('DiagnosticsTool');

const DiagnosticsPathSchema = z
  .string()
  .trim()
  .min(1)
  .describe('Workspace-relative or absolute file path.');

const DiagnosticsReadInputSchema = z.strictObject({
  command: z
    .enum(['list', 'count'])
    .describe('Use "list" for full diagnostics or "count" for a summary.'),
  path: DiagnosticsPathSchema,
});

const DIAGNOSTICS_READ_ONLY_DESCRIPTION =
  'Inspect diagnostics for a file. Use "list" to retrieve linter diagnostics or "count" for a severity summary.';

const DiagnosticsListSchema = z.strictObject({
  command: z
    .literal('list')
    .describe('Retrieve full linter diagnostics for a file.'),
  path: DiagnosticsPathSchema,
});

const DiagnosticsCountSchema = z.strictObject({
  command: z
    .literal('count')
    .describe(
      'Retrieve a severity-count summary of linter diagnostics for a file.',
    ),
  path: DiagnosticsPathSchema,
});

const DiagnosticsAddSchema = z.strictObject({
  command: z
    .literal('add')
    .describe(
      'Push a critique annotation as a diagnostic (squiggle + Problems panel entry) without inserting a literal \\criticize{...}{...}{...} macro into the document.',
    ),
  path: DiagnosticsPathSchema,
  line: z.int().min(1).describe('1-based line number where the issue occurs.'),
  message: z.string().min(1).describe('Description of the issue.'),
  severity: z
    .int()
    .min(0)
    .max(5)
    .describe(
      'Severity 0–5: 5=desk-rejection risk, 4=significantly weakens, 3=worth addressing, 2=minor polish, 1=cosmetic, 0=verified/correct.',
    ),
  confidence: z
    .int()
    .min(1)
    .max(5)
    .describe(
      'Confidence 1–5: 5=certain, 4=high certainty with minor subjectivity, 3=reasonable but field-dependent, 2=subjective, 1=speculative.',
    ),
});

export const DiagnosticsInputSchema = z.discriminatedUnion('command', [
  DiagnosticsListSchema,
  DiagnosticsCountSchema,
  DiagnosticsAddSchema,
]);

export type DiagnosticsInput = z.infer<typeof DiagnosticsInputSchema>;

export function withoutDiagnosticsAddCommand(
  tool: ToolDefinition,
): ToolDefinition {
  if (tool.name !== 'diagnostics') return tool;
  return {
    ...tool,
    description: DIAGNOSTICS_READ_ONLY_DESCRIPTION,
    parameters: toToolParameters(DiagnosticsReadInputSchema),
    zodSchema: DiagnosticsReadInputSchema,
  };
}

export class DiagnosticsTool extends defineTool({
  name: 'diagnostics',
  description:
    'Inspect or annotate diagnostics for a file. Use "list"/"count" to retrieve linter diagnostics; use "add" to push a critique annotation as a VS Code diagnostic (squiggle + Problems panel entry) instead of inserting a literal \\criticize{...}{...}{...} macro. The "add" command requires the experimental "texra.inlineCriticism.enabled" setting and reports "not accepted" if disabled; criticisms pushed this way are read back by "list".',
  schema: DiagnosticsInputSchema,
}) {
  protected async execute(input: DiagnosticsInput): Promise<ToolResult> {
    if (input.command === 'add') {
      return this.addCriticism(input);
    }
    return this.readDiagnostics(input);
  }

  /** Resolve an input path to an absolute path against the active working directory. */
  private resolveAbsolutePath(filePath: string): string {
    return resolveWorkspaceRelativePath(filePath, currentToolRoot()).absolute;
  }

  private async readDiagnostics(
    input: Extract<DiagnosticsInput, { command: 'list' | 'count' }>,
  ): Promise<ToolResult> {
    const { command, path } = input;
    const diagnosticsPath = this.resolveAbsolutePath(path);
    const linter = currentSession().interactions.readDiagnostics;
    if (!linter) {
      throw new ToolError(
        'Diagnostics capability unavailable: this session has no diagnostics provider.',
      );
    }

    try {
      const messages = await linter(diagnosticsPath);
      const counts = countBySeverity(messages);
      const header = `${diagnosticsPath}: ${formatCounts(counts)}`;
      const summary = `Diagnostics ${command} for ${diagnosticsPath}`;

      const baseDiagnostics = {
        path: diagnosticsPath,
        command,
        severity: counts,
      };

      if (command === 'count') {
        return {
          status: 'executed',
          summary,
          output: header,
          diagnostics: baseDiagnostics,
        };
      }

      const messageDetails =
        messages.length > 0 ? `\n\n${formatMessageList(messages)}` : '';
      return {
        status: 'executed',
        summary,
        output: `${header}${messageDetails}`,
        diagnostics: { ...baseDiagnostics, messages },
      };
    } catch (error) {
      const detail = toErrorMessage(error);
      log.error(
        `Failed to collect diagnostics for ${diagnosticsPath}: ${detail}`,
      );
      throw new ToolError(`Failed to collect diagnostics: ${detail}`);
    }
  }

  private async addCriticism(
    input: Extract<DiagnosticsInput, { command: 'add' }>,
  ): Promise<ToolResult> {
    const { path, line, message, severity, confidence } = input;
    const addCriticismSink = currentSession().interactions.addCriticism;
    if (!addCriticismSink) {
      throw new ToolError(
        'Diagnostics add capability unavailable: this session has no criticism sink.',
      );
    }

    try {
      const absolutePath = this.resolveAbsolutePath(path);
      const result = addCriticismSink({
        absolutePath,
        line,
        message,
        severity,
        confidence,
      });
      if (!result.accepted) {
        return executed(
          'Inline criticism diagnostics are disabled. Enable "texra.inlineCriticism.enabled" in settings to surface critiques as diagnostics.',
          'Criticism not accepted',
        );
      }
      const where = result.resolvedPath || absolutePath;
      const summary = `Added criticism for ${where}:${line} (S${severity}/C${confidence})`;
      return executed(summary, summary);
    } catch (error) {
      const detail = toErrorMessage(error);
      log.error(`Failed to add criticism: ${detail}`);
      throw new ToolError(`Failed to add criticism: ${detail}`);
    }
  }
}
