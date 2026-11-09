import { Cause, Effect, Result, Schema, Scope, Struct } from 'effect';

import { ToolContext, type ToolContextShape } from '@texra-ai/harness/plugins';
import {
  callerRun,
  resolveToolPath,
  errorResult,
  executed,
  nullishWithDefault,
  ToolError,
  defineTool,
  type ToolResult,
} from '@texra-ai/harness/plugins';
import { toErrorMessage, formatResultCount } from '@texra-ai/harness/schemas';
import {
  countBySeverity,
  formatCounts,
  formatGroupedSections,
} from '@texra/utils/diagnostics/diagnosticFormatting';
import {
  LEAN_FILE_COMMANDS,
  LEAN_PROJECT_COMMANDS,
  extractHoverText,
  type LeanCommandSpec,
  type LeanFileCommand,
  type LeanProjectCommand,
  type LeanUnavailable,
  type LspResult,
} from './leanTypes';
import {
  LeanLanguageServices,
  type LeanLanguageServicesShape,
} from './leanLanguageServices';

/** `- "name": Description (hint)` — the prose line for one command. */
function commandLine([name, spec]: [string, LeanCommandSpec]): string {
  return `- "${name}": ${spec.description}${spec.hint ? ` (${spec.hint})` : ''}`;
}

const FILE_COMMAND_NAMES: LeanFileCommand[] = Struct.keys(LEAN_FILE_COMMANDS);
const FILE_COMMAND_PROSE = Object.entries(LEAN_FILE_COMMANDS)
  .map(commandLine)
  .join('\n');

const PROJECT_COMMAND_NAMES: LeanProjectCommand[] = Struct.keys(
  LEAN_PROJECT_COMMANDS,
);

/** Project commands bucketed by their declared group, in declaration order. */
const PROJECT_COMMAND_GROUPS = Map.groupBy(
  Object.entries(LEAN_PROJECT_COMMANDS),
  ([, spec]) => spec.group,
);

const PROJECT_COMMAND_PROSE = [...PROJECT_COMMAND_GROUPS]
  .map(
    ([group, entries]) =>
      `${group} commands:\n${entries.map(commandLine).join('\n')}`,
  )
  .join('\n\n');

const PROJECT_COMMAND_GROUP_INDEX = [...PROJECT_COMMAND_GROUPS]
  .map(([group, entries]) => `${group}: ${entries.map(([n]) => n).join(', ')}`)
  .join('\n');

const LeanDiagnosticsInputSchema = Schema.Struct({
  /** Command: list for full messages, count for summary */
  command: nullishWithDefault(
    Schema.Literals(['list', 'count']),
    'list',
    'Use "list" for full messages or "count" for summary only',
  ),
  file: Schema.String.annotate({ description: 'Path to the .lean file' }),
});

type LeanDiagnosticsInput = typeof LeanDiagnosticsInputSchema.Type;

const LeanFileInputSchema = Schema.Struct({
  /** Command to execute on the file */
  command: Schema.Literals(FILE_COMMAND_NAMES).annotate({
    description: `Command: ${FILE_COMMAND_NAMES.map((name) => `"${name}"`).join(' or ')}`,
  }),
  file: Schema.String.annotate({ description: 'Path to the .lean file' }),
});

type LeanFileInput = typeof LeanFileInputSchema.Type;

const LeanProjectInputSchema = Schema.Struct({
  /** Command to execute */
  command: Schema.Literals(PROJECT_COMMAND_NAMES).annotate({
    description: `Global command to execute:\n${PROJECT_COMMAND_GROUP_INDEX}`,
  }),
});

type LeanProjectInput = typeof LeanProjectInputSchema.Type;

const INSPECT_TYPES = ['goal', 'term_goal', 'hover'] as const;

const LeanInspectInputSchema = Schema.Struct({
  /** What to inspect: goal, term_goal, or hover */
  type: Schema.Literals(INSPECT_TYPES).annotate({
    description:
      'What to inspect: "goal" for tactic proof state, "term_goal" for expected type in term mode, "hover" for type/docs',
  }),
  file: Schema.String.annotate({ description: 'Path to the .lean file' }),
  /** 1-indexed line number */
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: 'Line number (1-indexed)',
  }),
  /** 1-indexed column number */
  column: nullishWithDefault(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    1,
    'Column number (1-indexed, default: 1)',
  ),
});

type LeanInspectInput = typeof LeanInspectInputSchema.Type;

/** The tool's answer when Lean cannot serve a call: the adapter's message,
 *  which carries the setup advice where the toolchain is the cause. */
const leanUnavailableResult = (
  failed: string,
  failure: LeanUnavailable,
  summary: string,
): ToolResult => errorResult(`${failed}: ${failure.message}`, { summary });

const NO_DIAGNOSTICS_HELP = `No errors, warnings, or hints for this file.

If you expected errors:
1. Import/dependency errors may not surface as diagnostics: check imports manually
2. Make sure the file is saved
3. Try \`lean_file\` with command "restart" to refresh the Lean server`;

const catchLeanFailure = (
  message: (cause: unknown) => string,
  summary: string,
) =>
  Effect.catchCause((cause: Cause.Cause<Error>) => {
    if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
    const error = Cause.squash(cause);
    return Effect.fail(
      new ToolError(message(error), { cause: error, summary }),
    );
  });

function executeLeanDiagnosticsTool(
  input: LeanDiagnosticsInput,
): Effect.Effect<ToolResult, Error, ToolContext | LeanLanguageServices> {
  const { command, file } = input;
  return diagnose(file, command).pipe(
    catchLeanFailure(
      (cause) => `Error: ${toErrorMessage(cause)}`,
      'Failed to get diagnostics',
    ),
  );
}

const diagnose = Effect.fn('LeanDiagnosticsTool.execute')(function* (
  file: string,
  command: 'list' | 'count',
) {
  const call = yield* ToolContext;
  const services = yield* LeanLanguageServices;
  const absoluteFile = yield* leanFilePath(file, call);
  const fetched = yield* Effect.result(
    forCallerRun(services.fetchDiagnosticsForFile(absoluteFile)),
  );
  if (Result.isFailure(fetched)) {
    // Only a file that could not be opened is a "could not open file".
    const failure = fetched.failure;
    return failure._tag === 'LeanUnavailable'
      ? leanUnavailableResult(
          `Failed to get diagnostics for ${file}`,
          failure,
          'Failed to get diagnostics',
        )
      : errorResult(
          `Could not open file ${file}: ${failure.message}\n\nMake sure the file exists and is accessible.`,
          { summary: 'Failed to open file' },
        );
  }
  const result = fetched.success;
  const diagnostics = result.diagnostics;

  if (!result.complete) {
    // Diagnostics so far are not the file's verdict: an empty list must not
    // read as a clean file, nor a partial one as all its errors.
    const pending = `Lean has not finished elaborating ${file} yet (${formatResultCount(diagnostics.length, 'diagnostic')} so far); call again to get the complete result.`;
    return executed(
      command === 'list' && diagnostics.length > 0
        ? `${pending}\n\n${formatGroupedSections(diagnostics)}`
        : pending,
      'Still elaborating',
    );
  }

  const counts = countBySeverity(diagnostics);
  const countsStr = formatCounts(counts);

  if (diagnostics.length === 0) {
    return executed(NO_DIAGNOSTICS_HELP, '✓ No diagnostics');
  }

  if (command === 'count') {
    return {
      status: 'executed',
      summary: countsStr,
      output: `${file}: ${countsStr}`,
    } satisfies ToolResult;
  }

  return {
    status: 'executed',
    summary: countsStr,
    output: formatGroupedSections(diagnostics),
  } satisfies ToolResult;
});

export const LeanDiagnosticsTool = defineTool({
  name: 'lean_diagnostics',
  replay: 'safe',
  description: `Get diagnostic messages (errors, warnings, info) for a Lean 4 file.

Commands:
- "list" (default): Full diagnostic messages with locations
- "count": Summary counts only (faster for checking if file compiles)

Returns diagnostics from the Lean 4 language server including:
- Compilation errors with location
- Type mismatches
- Unsolved goals
- Warnings and hints

Tips:
- If diagnostics seem stale, use lean_file with command "restart" to refresh the Lean server
- Import/dependency errors may not surface as diagnostics: check imports manually`,
  schema: LeanDiagnosticsInputSchema,
  execute: executeLeanDiagnosticsTool,
});

export const LeanFileTool = defineTool({
  name: 'lean_file',
  description: `Execute Lean 4 language-server commands on a specific file.

Commands:
${FILE_COMMAND_PROSE}

In VS Code, these commands use the Lean 4 extension. CLI and desktop provide the corresponding direct operations where supported.`,
  schema: LeanFileInputSchema,
  execute: (
    input: LeanFileInput,
  ): Effect.Effect<ToolResult, Error, ToolContext | LeanLanguageServices> => {
    const { command, file } = input;
    const { description } = LEAN_FILE_COMMANDS[command];
    return Effect.gen(function* () {
      const call = yield* ToolContext;
      const services = yield* LeanLanguageServices;
      return yield* forCallerRun(
        services.executeFileCommand(command, yield* leanFilePath(file, call)),
      ).pipe(
        Effect.as(executed(`Executed "${command}" on ${file}`, description)),
        // The adapter's cause is the answer.
        Effect.catchTags({
          LeanFileCommandFailed: (failure) =>
            Effect.succeed(
              errorResult(
                `Could not execute "${command}" on ${file}: ${failure.message}`,
                { summary: 'Command failed' },
              ),
            ),
          LeanUnavailable: (failure) =>
            Effect.succeed(
              leanUnavailableResult(
                `Could not execute "${command}" on ${file}`,
                failure,
                'Command failed',
              ),
            ),
        }),
      );
    }).pipe(
      catchLeanFailure(
        (cause) => `Error: ${toErrorMessage(cause)}`,
        'Command failed',
      ),
    );
  },
});

export const LeanProjectTool = defineTool({
  name: 'lean_project',
  description: `Execute global Lean 4 language-server commands (no file required).

${PROJECT_COMMAND_PROSE}

In VS Code, these commands use the Lean 4 extension. CLI and desktop provide the corresponding direct operations where supported.`,
  schema: LeanProjectInputSchema,
  execute: (
    input: LeanProjectInput,
  ): Effect.Effect<ToolResult, Error, ToolContext | LeanLanguageServices> => {
    const { command } = input;
    const { description } = LEAN_PROJECT_COMMANDS[command];
    return Effect.gen(function* () {
      const services = yield* LeanLanguageServices;
      yield* forCallerRun(services.executeProjectCommand(command));

      if (command === 'build') {
        return executed(
          `Build started. Note: this command does not capture build output directly.\n\nTo check for errors and warnings, run lean_diagnostics on the relevant .lean files.`,
          description,
        );
      }

      return executed(`Executed "${command}" successfully`, description);
    }).pipe(
      catchLeanFailure(
        (cause) => `Error executing "${command}": ${toErrorMessage(cause)}`,
        'Command failed',
      ),
    );
  },
});

function executeLeanInspectTool(
  input: LeanInspectInput,
): Effect.Effect<ToolResult, Error, ToolContext | LeanLanguageServices> {
  const { type, file, line, column } = input;
  // Convert to 0-indexed for LSP
  const line0 = line - 1;
  const col0 = column - 1;
  const location = `${file}:${line}:${column}`;

  // The three inspections differ only in which request they make and how
  // they render an answer that carries data. Resolving the model's file
  // against the run and ruling on an answer that carries none is the same
  // for all three, so it is stated here once.
  const inspect = Effect.fn('inspect')(function* <T>(
    request: (
      services: LeanLanguageServicesShape,
      filePath: string,
    ) => Effect.Effect<LspResult<T>, never, Scope.Scope>,
    empty: { readonly message: string; readonly summary: string },
    render: (data: T) => ToolResult,
  ): Effect.fn.Return<ToolResult, Error, ToolContext | LeanLanguageServices> {
    const call = yield* ToolContext;
    const services = yield* LeanLanguageServices;
    const { data, error } = yield* forCallerRun(
      request(services, yield* leanFilePath(file, call)),
    );
    if (!data)
      return noPositionData(empty.message, location, empty.summary, error);
    return render(data);
  });

  // Each dispatch composes one program, run once below: a failed
  // language-server request finishes as this run's Exit and becomes the
  // ToolError carrying the summary that names which inspection failed.
  let program: Effect.Effect<
    ToolResult,
    Error,
    ToolContext | LeanLanguageServices
  >;
  switch (type) {
    case 'goal':
      program = inspect(
        (services, filePath) => services.getGoalState(filePath, line0, col0),
        { message: 'Could not get goal state', summary: 'No goal state' },
        (goal) =>
          goal.goals.length === 0
            ? executed(
                'No goals at this position. The proof may be complete here.',
                'No goals',
              )
            : executed(
                goal.rendered,
                formatResultCount(goal.goals.length, 'goal'),
              ),
      );
      break;
    case 'term_goal':
      program = inspect(
        (services, filePath) => services.getTermGoal(filePath, line0, col0),
        { message: 'No expected type', summary: 'No term goal' },
        (termGoal) => executed(termGoal.goal, 'Term goal'),
      );
      break;
    case 'hover':
      program = inspect(
        (services, filePath) => services.getHoverInfo(filePath, line0, col0),
        { message: 'No information', summary: 'No hover info' },
        (hover) => {
          const text = extractHoverText(hover.contents);
          return text
            ? executed(text, 'Hover info')
            : errorResult(`Empty hover response at ${location}`, {
                summary: 'No hover info',
              });
        },
      );
      break;
  }

  return program.pipe(
    catchLeanFailure(
      (cause) => `Error: ${toErrorMessage(cause)}`,
      `Failed to get ${type}`,
    ),
  );
}

export const LeanInspectTool = defineTool({
  name: 'lean_inspect',
  replay: 'safe',
  description: `Inspect proof state or type information at a position in a Lean 4 file.

Types:
- "goal": Get tactic proof state (what needs to be proven)
- "term_goal": Get expected type at cursor in term mode
- "hover": Get type signature and documentation for an identifier

Goal results render Lean's own proof-state text, or a "no goals" message
when none remain (the proof may be complete, or the cursor may be outside
a tactic block).

Line and column are 1-indexed.

In VS Code, this uses the Lean 4 extension. CLI and desktop provide the corresponding direct operations where supported.`,
  schema: LeanInspectInputSchema,
  execute: executeLeanInspectTool,
});

/**
 * Shared "language server returned nothing" error for the three inspect
 * dispatches. The optional LSP error string is surfaced inline so the
 * agent sees the underlying cause.
 */
function noPositionData(
  message: string,
  location: string,
  summary: string,
  error?: string,
): ToolResult {
  return errorResult(
    `${message} at ${location}${error ? `\nError: ${error}` : ''}`,
    { summary },
  );
}

/** Resolve a Lean file once in the invoking project before the host program runs. */
function leanFilePath(file: string, call: ToolContextShape) {
  return Effect.map(
    resolveToolPath(call.env, file),
    ({ absolute }) => absolute,
  );
}

/**
 * Run a port call with the scope the resources it starts stay held in: the
 * run's, so a Lean server it starts for the run stays up until the run ends,
 * or, outside a run, the call's own.
 */
function forCallerRun<A, E>(
  call: Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E, ToolContext> {
  return Effect.flatMap(callerRun, (run) =>
    run ? call.pipe(Scope.provide(run.scope)) : Effect.scoped(call),
  );
}
