import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { glob, hasMagic } from 'glob';
import { Effect, Scope } from 'effect';

import { CliUsageError } from '@cli/runtime/cliContext';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { unique } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';
// toPosixPath also trims and resolves `.`/`..` segments beyond a bare slash
// swap; safe at the call site below since the input is always a relative
// path from path.relative behind an isStrictlyWithin check.
import {
  isPathWithin,
  isStrictlyWithin,
  toPosixPath,
} from '@utils/core/pathCore';

const STDIN_INPUT_TOKEN = '-';
// LaTeX derives auxiliary filenames from the input basename; leading-dot
// job names can be rejected by TeX's file-open policy when it writes `.aux`.
const STDIN_TEMP_PREFIX = 'texra-stdin-';
export const STDIN_WORKFLOW_INPUT_BASENAME = 'stdin.tex';

export function workflowInputGlobOptions(
  platform: NodeJS.Platform,
): Readonly<{ magicalBraces: true; windowsPathsNoEscape: boolean }> {
  return {
    magicalBraces: true,
    windowsPathsNoEscape: platform === 'win32',
  };
}

function resolveAgainstCwd(candidate: string, cwd: string): string {
  return path.resolve(cwd, candidate);
}

function normalizeCliInputPath(candidate: string, cwd: string): string {
  const absolutePath = resolveAgainstCwd(candidate, cwd);
  return isStrictlyWithin(cwd, absolutePath)
    ? toPosixPath(path.relative(cwd, absolutePath))
    : absolutePath;
}

const normalizeCliInputPathForRun = Effect.fn('normalizeCliInputPathForRun')(
  function* (
    candidate: string,
    cwd: string,
    flagLabel: string,
    options: WorkflowInputExpansionOptions,
  ): Effect.fn.Return<string, CliUsageError> {
    if (
      options.requireWorkspaceFiles === true &&
      !isPathWithin(cwd, resolveAgainstCwd(candidate, cwd))
    ) {
      return yield* Effect.fail(
        new CliUsageError(`${flagLabel}: file is outside --cwd: ${candidate}`),
      );
    }
    return normalizeCliInputPath(candidate, cwd);
  },
);

function isStdinWorkflowInputSpec(inputSpec: string): boolean {
  return inputSpec.trim() === STDIN_INPUT_TOKEN;
}

interface WorkflowInputExpansionOptions {
  readonly allowEmpty?: boolean;
  readonly requireWorkspaceFiles?: boolean;
  readonly readStdinText?: () => Promise<string>;
}

type WorkflowInputExpansionEntry = readonly string[] | 'stdin';

interface PreparedWorkflowInputExpansion {
  readonly entries: WorkflowInputExpansionEntry[];
  readonly flagLabel: string;
  readonly readStdinText?: () => Promise<string>;
}

export function hasMixedStdinWorkflowInputSpecs(
  inputSpecs: readonly string[],
): boolean {
  const distinctSpecs = new Set(
    inputSpecs.map((spec) => spec.trim()).filter(Boolean),
  );
  return distinctSpecs.has(STDIN_INPUT_TOKEN) && distinctSpecs.size > 1;
}

const materializeStdinWorkflowInput = Effect.fn(
  'materializeStdinWorkflowInput',
)(function* (
  readStdinText: () => Promise<string>,
  tempDir: string,
): Effect.fn.Return<string, Error, Scope.Scope> {
  // No resource exists while stdin is pending. Interruption cannot leave a
  // Promise continuation that creates a directory after shutdown.
  const text = yield* Effect.tryPromise({
    try: readStdinText,
    catch: ensureError,
  });
  if (text.trim().length === 0)
    return yield* Effect.fail(
      new CliUsageError(
        'stdin: no data on stdin. Pipe content in and pass `-` to one file-taking flag.',
      ),
    );
  const inputDir = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        fs.mkdtemp(path.join(tempDir, `${STDIN_TEMP_PREFIX}${process.pid}-`)),
      catch: ensureError,
    }),
    (directory) =>
      Effect.tryPromise({
        try: () => fs.rm(directory, { recursive: true, force: true }),
        catch: ensureError,
      }).pipe(Effect.orDie),
  );
  const inputFile = path.join(inputDir, STDIN_WORKFLOW_INPUT_BASENAME);
  // Finish this finite local write before the scope removes its directory.
  yield* Effect.tryPromise({
    try: () => fs.writeFile(inputFile, text, { encoding: 'utf8', flag: 'wx' }),
    catch: ensureError,
  }).pipe(Effect.uninterruptible);
  return inputFile;
});

/**
 * Expand a single user-supplied path spec into the absolute / cwd-relative
 * paths it resolves to. The stdin token is resolved by
 * `prepareWorkflowInputExpansion` before it gets here, so it never reaches
 * this function.
 *
 * `flagLabel` is the CLI flag name (e.g. `--input`, `--context`) used in
 * Usage-error messages so a missing file is attributed to the right flag.
 * Defaults to `--input` for the common case; callers that pass context paths
 * (multi-agent `--context`) should override.
 */
const expandWorkflowInputSpec = Effect.fn('expandWorkflowInputSpec')(function* (
  inputSpec: string,
  cwd: string,
  flagLabel: string = '--input',
  options: WorkflowInputExpansionOptions = {},
): Effect.fn.Return<string[], Error> {
  const trimmed = inputSpec.trim();
  if (!trimmed) return [];

  const normalizeMatches = (matches: string[]) =>
    Effect.forEach(matches.toSorted(), (match) =>
      normalizeCliInputPathForRun(match, cwd, flagLabel, options),
    );

  const absolutePath = resolveAgainstCwd(trimmed, cwd);
  // Prefer an exact existing path even when its valid filename contains glob
  // syntax. Windows glob mode deliberately has no backslash escape channel.
  const stats = yield* Effect.tryPromise({
    try: () => fs.stat(absolutePath),
    catch: ensureError,
  }).pipe(
    Effect.catch((error) =>
      isFileNotFoundError(error) || isNotADirectoryError(error)
        ? Effect.succeed(null)
        : Effect.fail(error),
    ),
  );

  const globOptions = workflowInputGlobOptions(process.platform);
  if (!stats && hasMagic(trimmed, globOptions)) {
    const isAbsolute = path.isAbsolute(trimmed);
    const matches = yield* Effect.tryPromise({
      try: () =>
        glob(trimmed, {
          cwd: isAbsolute ? undefined : cwd,
          absolute: isAbsolute,
          nodir: true,
          ...globOptions,
        }),
      catch: ensureError,
    });
    if (matches.length === 0) {
      return yield* Effect.fail(
        new CliUsageError(`${flagLabel}: no files matched: ${trimmed}`),
      );
    }
    return yield* normalizeMatches(matches);
  }

  if (stats?.isDirectory()) {
    // Validate the directory itself before globbing its contents.
    yield* normalizeCliInputPathForRun(trimmed, cwd, flagLabel, options);
    const matches = yield* Effect.tryPromise({
      try: () =>
        glob('**/*.tex', {
          cwd: absolutePath,
          absolute: true,
          nodir: true,
        }),
      catch: ensureError,
    });
    if (matches.length === 0) {
      return yield* Effect.fail(
        new CliUsageError(`No .tex input files found in directory: ${trimmed}`),
      );
    }
    return yield* normalizeMatches(matches);
  }

  // Fail fast with a Usage error (exit 2) instead of paying full platform
  // init + agent loading just to ENOENT inside the agent run (exit 1).
  if (!stats) {
    return yield* Effect.fail(
      new CliUsageError(`${flagLabel}: file not found: ${trimmed}`),
    );
  }
  return [yield* normalizeCliInputPathForRun(trimmed, cwd, flagLabel, options)];
});

const prepareWorkflowInputExpansion = Effect.fn(
  'prepareWorkflowInputExpansion',
)(function* (
  inputSpecs: readonly string[],
  cwd: string,
  flagLabel: string,
  options: WorkflowInputExpansionOptions,
): Effect.fn.Return<PreparedWorkflowInputExpansion, Error> {
  const entries: WorkflowInputExpansionEntry[] = [];
  let readStdinText: (() => Promise<string>) | undefined;
  for (const spec of inputSpecs) {
    if (isStdinWorkflowInputSpec(spec)) {
      if (!options.readStdinText)
        return yield* Effect.fail(
          new CliUsageError(
            `${flagLabel}: '-' requires stdin input to be configured.`,
          ),
        );
      readStdinText = options.readStdinText;
      entries.push('stdin');
      continue;
    }
    entries.push(yield* expandWorkflowInputSpec(spec, cwd, flagLabel, options));
  }
  return { entries, flagLabel, readStdinText };
});

const finishWorkflowInputExpansion = Effect.fn('finishWorkflowInputExpansion')(
  function* (
    prepared: PreparedWorkflowInputExpansion,
    cwd: string,
    options: WorkflowInputExpansionOptions,
  ): Effect.fn.Return<
    { readonly files: string[]; readonly stdinPath?: string },
    Error,
    Scope.Scope
  > {
    const expanded: string[] = [];
    const stdinPath = prepared.readStdinText
      ? yield* normalizeCliInputPathForRun(
          yield* materializeStdinWorkflowInput(prepared.readStdinText, cwd),
          cwd,
          prepared.flagLabel,
          options,
        )
      : undefined;
    for (const entry of prepared.entries) {
      if (entry === 'stdin') {
        if (stdinPath) expanded.push(stdinPath);
        continue;
      }
      expanded.push(...entry);
    }
    const deduped = unique(expanded);
    if (deduped.length === 0 && options.allowEmpty !== true) {
      return yield* Effect.fail(
        new CliUsageError('At least one workflow input file is required.'),
      );
    }
    return { files: deduped, stdinPath };
  },
);

interface ExpandedRunInputs {
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  /** Path this invocation materialized stdin to, when the literal `-` token was
   *  expanded. Ground truth for "was this run's input read from stdin" — never
   *  re-derive it by inspecting a path's shape. */
  readonly stdinInputPath?: string;
}

/**
 * Expand the `--input` and `--context` specs a headless run accepts. `--input`
 * requires at least one resolved file unless `allowEmptyInput` is set.
 * `--context` is expanded with the same helper so a missing path fails as a
 * Usage error (exit 2) attributed to `--context`.
 */
export const expandRunInputs = Effect.fn('expandRunInputs')(function* (
  inputSpecs: readonly string[],
  contextSpecs: readonly string[],
  cwd: string,
  options: {
    readonly allowEmptyInput?: boolean;
    readonly requireWorkspaceFiles?: boolean;
    readonly readStdinText?: () => Promise<string>;
  } = {},
): Effect.fn.Return<ExpandedRunInputs, Error, Scope.Scope> {
  if (
    inputSpecs.some(isStdinWorkflowInputSpec) &&
    contextSpecs.some(isStdinWorkflowInputSpec)
  ) {
    return yield* Effect.fail(
      new CliUsageError(
        'Use `-` for either --input or --context, not both; stdin can only be read once.',
      ),
    );
  }

  const shared = {
    requireWorkspaceFiles: options.requireWorkspaceFiles,
    readStdinText: options.readStdinText,
  };
  const inputExpansion = yield* prepareWorkflowInputExpansion(
    inputSpecs,
    cwd,
    '--input',
    shared,
  );
  const contextExpansion = yield* prepareWorkflowInputExpansion(
    contextSpecs,
    cwd,
    '--context',
    shared,
  );

  const inputs = yield* finishWorkflowInputExpansion(inputExpansion, cwd, {
    ...shared,
    allowEmpty: options.allowEmptyInput,
  });
  const contexts = yield* finishWorkflowInputExpansion(contextExpansion, cwd, {
    ...shared,
    allowEmpty: true,
  });
  return {
    inputFiles: inputs.files,
    contextFiles: contexts.files,
    // `-` is rejected above when it appears in both, so at most one is set.
    stdinInputPath: inputs.stdinPath ?? contexts.stdinPath,
  };
});

/**
 * Own the stdin-temp-file lifecycle for headless runs that accept --input /
 * --context. Callers get already-expanded paths; this module creates and
 * removes the temporary stdin file whether expansion, execution, or output
 * handling fails.
 */
export function withExpandedRunInputs<T, E>(
  inputSpecs: readonly string[],
  contextSpecs: readonly string[],
  cwd: string,
  options: {
    readonly readStdinText: () => Promise<string>;
    readonly allowEmptyInput?: boolean;
    readonly requireWorkspaceFiles?: boolean;
  },
  run: (inputs: ExpandedRunInputs) => Effect.Effect<T, E>,
): Effect.Effect<T, E | Error> {
  return Effect.scoped(
    Effect.gen(function* () {
      const inputs = yield* expandRunInputs(
        inputSpecs,
        contextSpecs,
        cwd,
        options,
      );
      return yield* run(inputs);
    }),
  );
}
