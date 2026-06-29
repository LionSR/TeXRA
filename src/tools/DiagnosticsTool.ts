// Third-party imports
import { z } from 'zod';

// Internal imports
import { tryUseRunContext } from '@agent/runtime/RunContext';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { type ToolResult, ToolError } from '@shared/schemas/toolResult';
import { resolveWorkspaceRelativePath } from '@tools/pathResolution';
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';
import {
  countBySeverity,
  formatCounts,
  formatMessageList,
} from '@utils/diagnostics/diagnosticFormatting';

// Local file imports
import { defineTool } from './core/define';

const CHANNEL = 'DiagnosticsTool';
logger.initialize(CHANNEL);

type LinterProvider = (path: string) => Promise<GenericDiagnostic[]>;
let linterProvider: LinterProvider = async () => [];
/** Inject the VS Code linter diagnostics provider. Default: returns empty. */
export function setLinterProvider(provider: LinterProvider): void {
  linterProvider = provider;
}

/**
 * Host-resolved shape for a single criticism entry pushed by the `add`
 * command. The tool resolves the input `path` against the active working
 * directory before handing the entry to the host as `absolutePath`.
 */
export interface ManualCriticismEntry {
  /** Absolute path resolved by the tool. */
  absolutePath: string;
  /** 1-based line number. */
  line: number;
  message: string;
  /** 0–5; mapped to DiagnosticSeverity by the host. */
  severity: number;
  /** 1–5; appended to the message as `(S/C)`. */
  confidence: number;
}

/**
 * Sink injected by the extension host for the `add` command. Returns
 * `accepted: false` when the experimental setting is disabled so the tool can
 * surface that to the agent.
 */
export type AddCriticismSink = (input: ManualCriticismEntry) => {
  accepted: boolean;
  resolvedPath: string;
};

let criticismSink: AddCriticismSink = () => ({
  accepted: false,
  resolvedPath: '',
});

export function setAddCriticismSink(provider: AddCriticismSink): void {
  criticismSink = provider;
}

export const DiagnosticsInputSchema = z.strictObject({
  command: z
    .enum(['list', 'count', 'add'])
    .describe(
      'Use "list" for full diagnostics, "count" for a summary, or "add" to push a critique annotation as a diagnostic (squiggle + Problems panel) without inserting a literal \\criticize{...}{...}{...} macro into the document.',
    ),
  path: z
    .string()
    .trim()
    .min(1)
    .describe('Workspace-relative or absolute file path.'),
  line: z
    .int()
    .min(1)
    .nullish()
    .describe('add: 1-based line number where the issue occurs.'),
  message: z
    .string()
    .min(1)
    .nullish()
    .describe('add: description of the issue.'),
  severity: z
    .int()
    .min(0)
    .max(5)
    .nullish()
    .describe(
      'add: severity 0–5: 5=desk-rejection risk, 4=significantly weakens, 3=worth addressing, 2=minor polish, 1=cosmetic, 0=verified/correct.',
    ),
  confidence: z
    .int()
    .min(1)
    .max(5)
    .nullish()
    .describe(
      'add: confidence 1–5: 5=certain, 4=high certainty with minor subjectivity, 3=reasonable but field-dependent, 2=subjective, 1=speculative.',
    ),
});

export type DiagnosticsInput = z.infer<typeof DiagnosticsInputSchema>;

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

  private async readDiagnostics(input: DiagnosticsInput): Promise<ToolResult> {
    const { command, path } = input;
    const workingDirectory = tryUseRunContext()?.workingDirectory;
    const resolved = resolveWorkspaceRelativePath(path, workingDirectory);
    const diagnosticsPath = resolved.absolute;

    try {
      const messages = await linterProvider(diagnosticsPath);
      const counts = countBySeverity(messages);
      const header = `${diagnosticsPath}: ${formatCounts(counts)}`;
      const summary = `Diagnostics ${command} for ${diagnosticsPath}`;

      const baseDiagnostics = {
        path: diagnosticsPath,
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
        `Failed to collect diagnostics for ${diagnosticsPath}: ${detail}`,
      );
      throw new ToolError(`Failed to collect diagnostics: ${detail}`);
    }
  }

  private async addCriticism(input: DiagnosticsInput): Promise<ToolResult> {
    const { path, line, message, severity, confidence } = input;
    if (
      line == null ||
      message == null ||
      severity == null ||
      confidence == null
    ) {
      throw new ToolError(
        'The "add" command requires line, message, severity, and confidence.',
      );
    }

    try {
      const workingDirectory = tryUseRunContext()?.workingDirectory;
      const resolved = resolveWorkspaceRelativePath(path, workingDirectory);
      const result = criticismSink({
        absolutePath: resolved.absolute,
        line,
        message,
        severity,
        confidence,
      });
      if (!result.accepted) {
        return {
          summary: 'Criticism not accepted',
          output:
            'Inline criticism diagnostics are disabled. Enable "texra.inlineCriticism.enabled" in settings to surface critiques as diagnostics.',
        };
      }
      const where = result.resolvedPath || resolved.absolute;
      const summary = `Added criticism for ${where}:${line} (S${severity}/C${confidence})`;
      return { summary, output: summary };
    } catch (error) {
      const detail = toErrorMessage(error);
      logger.error(CHANNEL, `Failed to add criticism: ${detail}`);
      throw new ToolError(`Failed to add criticism: ${detail}`);
    }
  }
}
