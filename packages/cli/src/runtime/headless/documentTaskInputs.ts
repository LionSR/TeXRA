import { text as streamText } from 'node:stream/consumers';

import { Effect, FileSystem } from 'effect';

import { CliUsageError } from '@cli/runtime/platform/cliContext';
import { fromHost } from '@texra/controllers/session/hostCallFailure';
import {
  resolveTaskFiles,
  type TaskFileRole,
  type TaskFileSource,
  type TaskFiles,
  type TaskFilesReason,
} from '@texra/controllers/session/taskFiles';

const STDIN_INPUT_TOKEN = '-';
const STDIN_DOCUMENT_TASK_INPUT_BASENAME = 'stdin.tex';
/**
 * One wording for "a program's run has no input", said both for a spec that
 * resolves to nothing and by `texra run`'s pre-flight guard (no `--input` at
 * all), which has to refuse before it probes an output destination into
 * existence.
 */
export const DOCUMENT_TASK_INPUT_REQUIRED_MESSAGE =
  'At least one input file is required for a program.';

const FLAG_BY_ROLE: Readonly<Record<TaskFileRole, string>> = {
  input: '--input',
  context: '--context',
};

/** A refused file named on the command line, in the flag's words. */
function usageMessage(reason: TaskFilesReason): string {
  switch (reason._tag) {
    case 'NotFound':
      return `${FLAG_BY_ROLE[reason.role]}: file not found: ${reason.path}`;
    case 'NoMatch':
      return `${FLAG_BY_ROLE[reason.role]}: no files matched: ${reason.pattern}`;
    case 'NoTexFiles':
      return `No .tex input files found in directory: ${reason.directory}`;
    case 'OutsideProject':
      return `${FLAG_BY_ROLE[reason.role]}: file is outside --cwd: ${reason.path}`;
    case 'EmptyText':
      return 'stdin: no data on stdin. Pipe content in and pass `-` to one file-taking flag.';
    case 'NoInput':
      return DOCUMENT_TASK_INPUT_REQUIRED_MESSAGE;
  }
}

function isStdinSpec(spec: string): boolean {
  return spec.trim() === STDIN_INPUT_TOKEN;
}

// With an encoding set the chunks are strings, so a leading BOM is kept.
const readProcessStdinText = fromHost('process.stdin', () =>
  streamText(process.stdin.setEncoding('utf8')),
);

export function hasMixedStdinDocumentTaskInputSpecs(
  inputSpecs: readonly string[],
): boolean {
  const distinctSpecs = new Set(
    inputSpecs.map((spec) => spec.trim()).filter(Boolean),
  );
  return distinctSpecs.has(STDIN_INPUT_TOKEN) && distinctSpecs.size > 1;
}

/** One flag's specs as sources. `-` is stdin, read once: a later `-` in the
 *  same flag names the same file, so it is dropped. */
function flagSources(
  role: TaskFileRole,
  specs: readonly string[],
): TaskFileSource[] {
  let stdinNamed = false;
  return specs.flatMap((spec): TaskFileSource[] => {
    if (!isStdinSpec(spec)) return [{ role, spec }];
    if (stdinNamed) return [];
    stdinNamed = true;
    return [
      {
        role,
        text: readProcessStdinText,
        name: STDIN_DOCUMENT_TASK_INPUT_BASENAME,
      },
    ];
  });
}

/**
 * Expand the `--input` and `--context` specs a headless run accepts and hold
 * the stdin file `-` writes for as long as `run` runs: it is removed whether
 * expansion, the run, or output handling fails. A program needs at least one
 * input and may read files outside `cwd`; an agent may have none and reads
 * only inside it.
 */
export function withExpandedRunInputs<T, E, R = never>(
  inputSpecs: readonly string[],
  contextSpecs: readonly string[],
  cwd: string,
  task: 'program' | 'agent',
  run: (inputs: TaskFiles) => Effect.Effect<T, E, R>,
): Effect.Effect<T, E | Error, R | FileSystem.FileSystem> {
  if (inputSpecs.some(isStdinSpec) && contextSpecs.some(isStdinSpec)) {
    return Effect.fail(
      new CliUsageError({
        message:
          'Use `-` for either --input or --context, not both; stdin can only be read once.',
      }),
    );
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const files = yield* resolveTaskFiles(
        [
          ...flagSources('input', inputSpecs),
          ...flagSources('context', contextSpecs),
        ],
        cwd,
        task,
      ).pipe(
        Effect.catchTag('TaskFilesRejected', ({ reason }) =>
          Effect.fail(new CliUsageError({ message: usageMessage(reason) })),
        ),
      );
      return yield* run(files);
    }),
  );
}
