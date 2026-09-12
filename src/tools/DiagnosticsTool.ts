// Node imports

// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';
import { ToolCall } from '@agent/runtime/ToolCall';

// Local imports
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { hostPort } from '@common/hostPort';
import { createLog } from '@logger/logUtils';
import { type ToolResult, ToolError } from '@shared/schemas';
import {
  parseWorkingDirectory,
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
import { defineTool } from './core/define';

const log = createLog('DiagnosticsTool');

/**
 * The host capabilities and working directory this tool reads from the
 * session, resolved in the caller's run context before the program runs.
 */
interface DiagnosticsPorts {
  /**
   * Reads the active working directory, bound to the calling turn. It stays a
   * thunk so each command asks for it exactly where it did before: parsing
   * rejects a relative working directory, and "add" reports that failure as
   * its own.
   */
  readonly toolRoot: () => string | undefined;
  readonly inScope: <A>(operation: () => A) => A;
  readonly readDiagnostics: HostInteractions['readDiagnostics'];
  readonly addCriticism: HostInteractions['addCriticism'];
}

/** Resolve an input path to an absolute path against the active working directory. */
function resolveAbsolutePath(
  filePath: string,
  root: string | undefined,
): string {
  return resolveWorkspaceRelativePath(filePath, root).absolute;
}

const DiagnosticsPathSchema = z
  .string()
  .trim()
  .min(1)
  .describe('Workspace-relative or absolute file path.');

// Branches use looseObject (not strictObject): provider conversion flattens
// the union into one advertised object and OpenAI-compatible providers
// null-fill the properties belonging to the other commands. See AGENTS.md
// "Tool input schemas".
const DiagnosticsListSchema = z.looseObject({
  command: z
    .literal('list')
    .describe('Retrieve full linter diagnostics for a file.'),
  path: DiagnosticsPathSchema,
});

const DiagnosticsCountSchema = z.looseObject({
  command: z
    .literal('count')
    .describe(
      'Retrieve a severity-count summary of linter diagnostics for a file.',
    ),
  path: DiagnosticsPathSchema,
});

const DiagnosticsAddSchema = z.looseObject({
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

export class DiagnosticsTool extends defineTool({
  name: 'diagnostics',
  // No diagnostics provider is installed on either host.
  unavailableHosts: ['cli', 'desktop'],
  description:
    'Inspect or annotate diagnostics for a file. Use "list"/"count" to retrieve linter diagnostics; use "add" to push a critique annotation as a VS Code diagnostic (squiggle + Problems panel entry) instead of inserting a literal \\criticize{...}{...}{...} macro. The "add" command requires the experimental "texra.inlineCriticism.enabled" setting and reports "not accepted" if disabled; criticisms pushed this way are read back by "list".',
  schema: DiagnosticsInputSchema,
}) {
  protected readonly execute = Effect.fn('DiagnosticsTool.call')(function* (
    this: DiagnosticsTool,
    input: DiagnosticsInput,
  ) {
    const call = yield* ToolCall;
    const interactions = call.run?.session.interactions;
    if (!interactions)
      return yield* Effect.fail(
        new ToolError('Diagnostics requires an active session.'),
      );
    const ports: DiagnosticsPorts = {
      toolRoot: () => parseWorkingDirectory(call.workingDirectory),
      inScope: call.inScope,
      readDiagnostics: interactions.readDiagnostics,
      addCriticism: interactions.addCriticism,
    };
    return yield* input.command === 'add'
      ? this.addCriticism(ports, input)
      : this.readDiagnostics(ports, input);
  });

  private readonly readDiagnostics = Effect.fn(
    'DiagnosticsTool.readDiagnostics',
  )(function* (
    ports: DiagnosticsPorts,
    input: Extract<DiagnosticsInput, { command: 'list' | 'count' }>,
  ): Effect.fn.Return<ToolResult, ToolError> {
    const { command, path } = input;
    const diagnosticsPath = ports.inScope(() =>
      resolveAbsolutePath(path, ports.toolRoot()),
    );
    const linter = ports.readDiagnostics;
    if (!linter) {
      return yield* Effect.fail(
        new ToolError(
          'Diagnostics capability unavailable: this session has no diagnostics provider.',
        ),
      );
    }

    const messages = yield* hostPort(() => linter(diagnosticsPath)).pipe(
      Effect.catch((error) => {
        const detail = toErrorMessage(error);
        log.error(
          `Failed to collect diagnostics for ${diagnosticsPath}: ${detail}`,
        );
        return Effect.fail(
          new ToolError(`Failed to collect diagnostics: ${detail}`),
        );
      }),
    );
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
  });

  private readonly addCriticism = Effect.fn('DiagnosticsTool.addCriticism')(
    function* (
      ports: DiagnosticsPorts,
      input: Extract<DiagnosticsInput, { command: 'add' }>,
    ): Effect.fn.Return<ToolResult, ToolError> {
      const { path, line, message, severity, confidence } = input;
      const addCriticismSink = ports.addCriticism;
      if (!addCriticismSink) {
        return yield* Effect.fail(
          new ToolError(
            'Diagnostics add capability unavailable: this session has no criticism sink.',
          ),
        );
      }

      // Path resolution shares the sink's failure report: both are the "add"
      // command failing before it could annotate anything.
      const added = yield* Effect.try({
        try: () =>
          ports.inScope(() => {
            const absolutePath = resolveAbsolutePath(path, ports.toolRoot());
            return {
              absolutePath,
              result: addCriticismSink({
                absolutePath,
                line,
                message,
                severity,
                confidence,
              }),
            };
          }),
        catch: (error) => {
          const detail = toErrorMessage(error);
          log.error(`Failed to add criticism: ${detail}`);
          return new ToolError(`Failed to add criticism: ${detail}`);
        },
      });
      if (!added.result.accepted) {
        return executed(
          'Inline criticism diagnostics are disabled. Enable "texra.inlineCriticism.enabled" in settings to surface critiques as diagnostics.',
          'Criticism not accepted',
        );
      }
      const where = added.result.resolvedPath || added.absolutePath;
      const summary = `Added criticism for ${where}:${line} (S${severity}/C${confidence})`;
      return executed(summary, summary);
    },
  );
}
