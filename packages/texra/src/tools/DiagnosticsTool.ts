// Node imports

// Third-party imports
import { Effect, Schema } from 'effect';
import { defineTool, type ToolResult } from '@texra-ai/harness';
import { ToolContext } from '@texra-ai/harness/plugins';
import { withLogChannel } from '@texra-ai/harness/host';

// Local imports
import { toErrorMessage } from '@texra-ai/harness/schemas';
import {
  resolveToolPath,
  type ToolPathCall,
  executed,
  ToolError,
} from '@texra-ai/harness/plugins';
import {
  countBySeverity,
  formatCounts,
  formatMessageList,
} from '@texra/utils/diagnostics/diagnosticFormatting';

// Local file imports
import {
  EditorHost,
  type EditorCapabilities,
  type EditorCapability,
} from './editorHost';

const CHANNEL = 'DiagnosticsTool';

/**
 * The host capabilities and working directory this tool reads from the
 * session, resolved in the caller's run context before the program runs.
 */
interface DiagnosticsPorts {
  readonly call: ToolPathCall;
  readonly readDiagnostics: EditorCapabilities['readDiagnostics'];
  readonly addCriticism: EditorCapabilities['addCriticism'];
}

const DiagnosticsPathSchema = Schema.Trim.check(Schema.isMinLength(1)).annotate(
  { description: 'Workspace-relative or absolute file path.' },
);

const DiagnosticsInputSchema = Schema.Union([
  Schema.StructWithRest(
    Schema.Struct({
      command: Schema.Literal('list').annotate({
        description: 'Retrieve full linter diagnostics for a file.',
      }),
      path: DiagnosticsPathSchema,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      command: Schema.Literal('count').annotate({
        description:
          'Retrieve a severity-count summary of linter diagnostics for a file.',
      }),
      path: DiagnosticsPathSchema,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      command: Schema.Literal('add').annotate({
        description:
          'Push a critique annotation as a diagnostic (squiggle + Problems panel entry) without inserting a literal \\criticize{...}{...}{...} macro into the document.',
      }),
      path: DiagnosticsPathSchema,
      line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: '1-based line number where the issue occurs.',
      }),
      message: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: 'Description of the issue.',
      }),
      severity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(5))
        .annotate({
          description:
            'Severity 0–5: 5=desk-rejection risk, 4=significantly weakens, 3=worth addressing, 2=minor polish, 1=cosmetic, 0=verified/correct.',
        }),
      confidence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(5))
        .annotate({
          description:
            'Confidence 1–5: 5=certain, 4=high certainty with minor subjectivity, 3=reasonable but field-dependent, 2=subjective, 1=speculative.',
        }),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
]);

type DiagnosticsInput = typeof DiagnosticsInputSchema.Type;

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
  const accepted = yield* addCriticismSink({
    absolutePath,
    line,
    message,
    severity,
    confidence,
  }).pipe(
    Effect.mapError(
      (error) =>
        new ToolError(`Failed to add criticism: ${toErrorMessage(error)}`),
    ),
    Effect.tapError((error) =>
      Effect.logError(error.message).pipe(withLogChannel(CHANNEL)),
    ),
  );
  if (!accepted) {
    return executed(
      'Inline criticism diagnostics are disabled. Enable "texra.inlineCriticism.enabled" in settings to surface critiques as diagnostics.',
      'Criticism not accepted',
    );
  }
  const summary = `Added criticism for ${absolutePath}:${line} (S${severity}/C${confidence})`;
  return executed(summary, summary);
});

const diagnose = Effect.fn('DiagnosticsTool.call')(function* (
  input: DiagnosticsInput,
) {
  const { env } = yield* ToolContext;
  const editor = (yield* EditorHost).at(env.roots.storage);
  const ports: DiagnosticsPorts = {
    call: env,
    readDiagnostics: editor.readDiagnostics,
    addCriticism: editor.addCriticism,
  };
  return yield* input.command === 'add'
    ? addCriticism(ports, input)
    : readDiagnostics(ports, input);
});

export const DiagnosticsTool = defineTool({
  name: 'diagnostics',
  // Offered while an editor attached for the session reads diagnostics
  // (`EditorHost`): the extension's own session, or a service task with
  // one of its windows.
  hostCapability: 'diagnostics' satisfies EditorCapability,
  unavailableHosts: ['desktop', 'sdk'],
  description:
    'Inspect or annotate diagnostics for a file. Use "list"/"count" to retrieve linter diagnostics; use "add" to push a critique annotation as a VS Code diagnostic (squiggle + Problems panel entry) instead of inserting a literal \\criticize{...}{...}{...} macro. The "add" command requires the experimental "texra.inlineCriticism.enabled" setting and reports "not accepted" if disabled; criticisms pushed this way are read back by "list".',
  schema: DiagnosticsInputSchema,
  execute: diagnose,
});
