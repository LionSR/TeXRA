// Node imports

// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';
import { ToolCall } from '@agent/runtime/ToolCall';

// Local imports
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { withLogChannel } from '@logger/effectLog';
import { type ToolResult, ToolError } from '@shared/schemas';
import { resolveToolPath, type ToolPathCall } from '@tools/pathResolution';
import { executed } from '@tools/core/result';
import {
  countBySeverity,
  formatCounts,
  formatMessageList,
} from '@utils/diagnostics/diagnosticFormatting';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { defineTool } from './core/define';

const CHANNEL = 'DiagnosticsTool';

/**
 * The host capabilities and working directory this tool reads from the
 * session, resolved in the caller's run context before the program runs.
 */
interface DiagnosticsPorts {
  readonly call: ToolPathCall;
  readonly readDiagnostics: HostInteractions['readDiagnostics'];
  readonly addCriticism: HostInteractions['addCriticism'];
}

const DiagnosticsPathSchema = z
  .string()
  .trim()
  .min(1)
  .describe('Workspace-relative or absolute file path.');

const DiagnosticsInputSchema = z.discriminatedUnion('command', [
  z.looseObject({
    command: z
      .literal('list')
      .describe('Retrieve full linter diagnostics for a file.'),
    path: DiagnosticsPathSchema,
  }),
  z.looseObject({
    command: z
      .literal('count')
      .describe(
        'Retrieve a severity-count summary of linter diagnostics for a file.',
      ),
    path: DiagnosticsPathSchema,
  }),
  z.looseObject({
    command: z
      .literal('add')
      .describe(
        'Push a critique annotation as a diagnostic (squiggle + Problems panel entry) without inserting a literal \\criticize{...}{...}{...} macro into the document.',
      ),
    path: DiagnosticsPathSchema,
    line: z
      .int()
      .min(1)
      .describe('1-based line number where the issue occurs.'),
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
  }),
]);

type DiagnosticsInput = z.infer<typeof DiagnosticsInputSchema>;

const readDiagnostics = Effect.fn('DiagnosticsTool.readDiagnostics')(function* (
  ports: DiagnosticsPorts,
  input: Extract<DiagnosticsInput, { command: 'list' | 'count' }>,
): Effect.fn.Return<ToolResult, Error> {
  const { command, path } = input;
  const diagnosticsPath = (yield* resolveToolPath(ports.call, path)).absolute;
  const linter = ports.readDiagnostics;
  if (!linter) {
    return yield* Effect.fail(
      new ToolError(
        'Diagnostics capability unavailable: this session has no diagnostics provider.',
      ),
    );
  }

  // The host's own failure, matched by tag: `reason` says whether the
  // refresh build faulted or the collection itself threw, and the agent is
  // told which.
  const messages = yield* linter(diagnosticsPath).pipe(
    Effect.catchTag('DiagnosticsReadFailed', (error) =>
      Effect.logError(
        `Failed to collect diagnostics for ${diagnosticsPath} (${error.reason}): ${error.message}`,
      ).pipe(
        withLogChannel(CHANNEL),
        Effect.flatMap(() =>
          Effect.fail(
            new ToolError(
              `Failed to collect diagnostics (${error.reason}): ${error.message}`,
            ),
          ),
        ),
      ),
    ),
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

const addCriticism = Effect.fn('DiagnosticsTool.addCriticism')(function* (
  ports: DiagnosticsPorts,
  input: Extract<DiagnosticsInput, { command: 'add' }>,
): Effect.fn.Return<ToolResult, Error> {
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
  const absolutePath = (yield* resolveToolPath(ports.call, path)).absolute;
  const added = yield* Effect.try({
    try: () => {
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
    },
    catch: (error) =>
      new ToolError(`Failed to add criticism: ${toErrorMessage(error)}`),
  }).pipe(
    Effect.tapError((error) =>
      Effect.logError(error.message).pipe(withLogChannel(CHANNEL)),
    ),
  );
  if (!added.result.accepted) {
    return executed(
      'Inline criticism diagnostics are disabled. Enable "texra.inlineCriticism.enabled" in settings to surface critiques as diagnostics.',
      'Criticism not accepted',
    );
  }
  const where = added.result.resolvedPath || added.absolutePath;
  const summary = `Added criticism for ${where}:${line} (S${severity}/C${confidence})`;
  return executed(summary, summary);
});

const diagnose = Effect.fn('DiagnosticsTool.call')(function* (
  input: DiagnosticsInput,
) {
  const call = yield* ToolCall;
  const interactions = call.run?.session.interactions;
  if (!interactions)
    return yield* Effect.fail(
      new ToolError('Diagnostics requires an active session.'),
    );
  const ports: DiagnosticsPorts = {
    call,
    readDiagnostics: interactions.readDiagnostics,
    addCriticism: interactions.addCriticism,
  };
  return yield* input.command === 'add'
    ? addCriticism(ports, input)
    : readDiagnostics(ports, input);
});

export const DiagnosticsTool = defineTool({
  name: 'diagnostics',
  // No diagnostics provider is installed on either host.
  unavailableHosts: ['cli', 'desktop'],
  description:
    'Inspect or annotate diagnostics for a file. Use "list"/"count" to retrieve linter diagnostics; use "add" to push a critique annotation as a VS Code diagnostic (squiggle + Problems panel entry) instead of inserting a literal \\criticize{...}{...}{...} macro. The "add" command requires the experimental "texra.inlineCriticism.enabled" setting and reports "not accepted" if disabled; criticisms pushed this way are read back by "list".',
  schema: DiagnosticsInputSchema,
  execute: diagnose,
});
