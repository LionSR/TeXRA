import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { glob, hasMagic } from 'glob';

import { CliUsageError } from '@cli/runtime/cliContext';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';

const STDIN_INPUT_TOKEN = '-';
const STDIN_TEMP_PREFIX = '.texra-stdin-';

function resolveAgainstCwd(candidate: string, cwd: string): string {
  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(cwd, candidate);
}

function normalizeCliInputPath(candidate: string, cwd: string): string {
  const absolutePath = resolveAgainstCwd(candidate, cwd);
  const relativePath = path.relative(cwd, absolutePath);
  if (
    relativePath &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  ) {
    return relativePath.replaceAll(path.sep, '/');
  }
  return absolutePath;
}

function isStdinWorkflowInputSpec(inputSpec: string): boolean {
  return inputSpec.trim() === STDIN_INPUT_TOKEN;
}

export interface WorkflowInputExpansionOptions {
  readonly allowEmpty?: boolean;
  readonly stdinInputFile?: () => Promise<string>;
}

type WorkflowInputExpansionEntry = readonly string[] | 'stdin';

interface PreparedWorkflowInputExpansion {
  readonly entries: WorkflowInputExpansionEntry[];
  readonly stdinInputFile?: () => Promise<string>;
}

export type StdinWorkflowInputMaterializer = (() => Promise<string>) & {
  cleanup: () => Promise<void>;
};

export function hasMixedStdinWorkflowInputSpecs(
  inputSpecs: readonly string[],
): boolean {
  const distinctSpecs = new Set(
    inputSpecs.map((spec) => spec.trim()).filter(Boolean),
  );
  return distinctSpecs.has(STDIN_INPUT_TOKEN) && distinctSpecs.size > 1;
}

export function createStdinWorkflowInputMaterializer(options: {
  readonly readStdinText: () => Promise<string>;
  readonly tempDir: string;
}): StdinWorkflowInputMaterializer {
  let materialized: Promise<string> | undefined;
  const inputFile = (() => {
    materialized ??= materializeStdinWorkflowInput(options);
    return materialized;
  }) as StdinWorkflowInputMaterializer;
  inputFile.cleanup = async () => {
    if (!materialized) return;
    const inputPath = await materialized.catch(() => undefined);
    if (inputPath) {
      await fs.rm(inputPath, { force: true });
    }
  };
  return inputFile;
}

async function materializeStdinWorkflowInput(options: {
  readonly readStdinText: () => Promise<string>;
  readonly tempDir: string;
}): Promise<string> {
  const text = await options.readStdinText();
  if (text.trim().length === 0) {
    throw new CliUsageError(
      'stdin: no data on stdin. Pipe content in and pass `-` to one file-taking flag.',
    );
  }
  const inputFile = path.join(
    options.tempDir,
    `${STDIN_TEMP_PREFIX}${process.pid}-${randomUUID()}.tex`,
  );
  await fs.writeFile(inputFile, text, { encoding: 'utf8', flag: 'wx' });
  return inputFile;
}

function requireStdinWorkflowInputFile(
  flagLabel: string,
  options: WorkflowInputExpansionOptions,
): () => Promise<string> {
  if (!options.stdinInputFile) {
    throw new CliUsageError(
      `${flagLabel}: '-' requires stdin input to be configured.`,
    );
  }
  return options.stdinInputFile;
}

/**
 * Expand a single user-supplied path spec into the absolute / cwd-relative
 * paths it resolves to.
 *
 * `flagLabel` is the CLI flag name (e.g. `--input`, `--context`) used in
 * Usage-error messages so a missing file is attributed to the right flag.
 * Defaults to `--input` for the common case; callers that pass context paths
 * (multi-agent `--context`) should override.
 */
export async function expandWorkflowInputSpec(
  inputSpec: string,
  cwd: string,
  flagLabel: string = '--input',
  options: WorkflowInputExpansionOptions = {},
): Promise<string[]> {
  const trimmed = inputSpec.trim();
  if (!trimmed) return [];

  if (trimmed === STDIN_INPUT_TOKEN) {
    const stdinInputFile = requireStdinWorkflowInputFile(flagLabel, options);
    return [normalizeCliInputPath(await stdinInputFile(), cwd)];
  }

  if (hasMagic(trimmed)) {
    const isAbsolute = path.isAbsolute(trimmed);
    const matches = await glob(trimmed.replaceAll('\\', '/'), {
      cwd: isAbsolute ? undefined : cwd,
      absolute: isAbsolute,
      nodir: true,
    });
    if (matches.length === 0) {
      throw new CliUsageError(`No input files matched: ${trimmed}`);
    }
    return matches.sort().map((match) => normalizeCliInputPath(match, cwd));
  }

  const absolutePath = resolveAgainstCwd(trimmed, cwd);
  // Only treat true missing-path errors as "file not found"; other failures
  // (EACCES, EIO, ...) are environment problems, not Usage errors, and must
  // propagate so the user sees the real cause.
  let stats: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    stats = await fs.stat(absolutePath);
  } catch (error: unknown) {
    if (!isFileNotFoundError(error) && !isNotADirectoryError(error)) {
      throw error;
    }
  }
  if (stats?.isDirectory()) {
    const matches = await glob('**/*.tex', {
      cwd: absolutePath,
      absolute: true,
      nodir: true,
    });
    if (matches.length === 0) {
      throw new CliUsageError(
        `No .tex input files found in directory: ${trimmed}`,
      );
    }
    return matches.sort().map((match) => normalizeCliInputPath(match, cwd));
  }

  // Fail fast with a Usage error (exit 2) instead of paying full platform
  // init + agent loading just to ENOENT inside the agent run (exit 1).
  if (!stats) {
    throw new CliUsageError(`${flagLabel}: file not found: ${trimmed}`);
  }
  return [normalizeCliInputPath(trimmed, cwd)];
}

export async function expandWorkflowInputSpecs(
  inputSpecs: readonly string[],
  cwd: string,
  flagLabel: string = '--input',
  options: WorkflowInputExpansionOptions = {},
): Promise<string[]> {
  return finishWorkflowInputExpansion(
    await prepareWorkflowInputExpansion(inputSpecs, cwd, flagLabel, options),
    cwd,
    options,
  );
}

async function prepareWorkflowInputExpansion(
  inputSpecs: readonly string[],
  cwd: string,
  flagLabel: string,
  options: WorkflowInputExpansionOptions,
): Promise<PreparedWorkflowInputExpansion> {
  const entries: WorkflowInputExpansionEntry[] = [];
  let stdinInputFile: (() => Promise<string>) | undefined;
  for (const spec of inputSpecs) {
    if (isStdinWorkflowInputSpec(spec)) {
      stdinInputFile = requireStdinWorkflowInputFile(flagLabel, options);
      entries.push('stdin');
      continue;
    }
    entries.push(await expandWorkflowInputSpec(spec, cwd, flagLabel));
  }
  return { entries, stdinInputFile };
}

async function finishWorkflowInputExpansion(
  prepared: PreparedWorkflowInputExpansion,
  cwd: string,
  options: WorkflowInputExpansionOptions,
): Promise<string[]> {
  const expanded: string[] = [];
  const stdinPath = prepared.stdinInputFile
    ? normalizeCliInputPath(await prepared.stdinInputFile(), cwd)
    : undefined;
  for (const entry of prepared.entries) {
    if (entry === 'stdin') {
      if (stdinPath) expanded.push(stdinPath);
      continue;
    }
    expanded.push(...entry);
  }
  const unique = [...new Set(expanded)];
  if (unique.length === 0 && options.allowEmpty !== true) {
    throw new CliUsageError('At least one workflow input file is required.');
  }
  return unique;
}

/**
 * Expand the `--input` and `--context` specs a headless run accepts. `--input`
 * requires at least one resolved file unless `allowEmptyInput` is set.
 * `--context` is expanded with the same helper so a missing path fails as a
 * Usage error (exit 2) attributed to `--context`.
 */
export async function expandRunInputs(
  inputSpecs: readonly string[],
  contextSpecs: readonly string[],
  cwd: string,
  options: {
    readonly allowEmptyInput?: boolean;
    readonly stdinInputFile?: () => Promise<string>;
  } = {},
): Promise<{ inputFiles: string[]; contextFiles: string[] }> {
  if (
    inputSpecs.some(isStdinWorkflowInputSpec) &&
    contextSpecs.some(isStdinWorkflowInputSpec)
  ) {
    throw new CliUsageError(
      'Use `-` for either --input or --context, not both; stdin can only be read once.',
    );
  }

  const inputExpansion = await prepareWorkflowInputExpansion(
    inputSpecs,
    cwd,
    '--input',
    { stdinInputFile: options.stdinInputFile },
  );
  const contextExpansion = await prepareWorkflowInputExpansion(
    contextSpecs,
    cwd,
    '--context',
    { stdinInputFile: options.stdinInputFile },
  );

  const inputFiles = await finishWorkflowInputExpansion(inputExpansion, cwd, {
    allowEmpty: options.allowEmptyInput,
    stdinInputFile: options.stdinInputFile,
  });
  const contextFiles = await finishWorkflowInputExpansion(
    contextExpansion,
    cwd,
    {
      allowEmpty: true,
      stdinInputFile: options.stdinInputFile,
    },
  );
  return { inputFiles, contextFiles };
}
