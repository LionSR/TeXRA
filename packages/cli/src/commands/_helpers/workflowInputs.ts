import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { glob, hasMagic } from 'glob';

import { CliUsageError } from '@cli/runtime/cliContext';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';

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

export interface WorkflowInputExpansionOptions {
  readonly allowEmpty?: boolean;
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
  return distinctSpecs.has('-') && distinctSpecs.size > 1;
}

export function createStdinWorkflowInputMaterializer(options: {
  readonly readStdinText: () => Promise<string>;
  readonly tempDir?: string;
}): StdinWorkflowInputMaterializer {
  let materialized:
    | Promise<{ readonly directory: string; readonly inputFile: string }>
    | undefined;
  const inputFile = (() => {
    materialized ??= materializeStdinWorkflowInput(options);
    return materialized.then((result) => result.inputFile);
  }) as StdinWorkflowInputMaterializer;
  inputFile.cleanup = async () => {
    if (!materialized) return;
    const result = await materialized.catch(() => undefined);
    if (result) {
      await fs.rm(result.directory, { recursive: true, force: true });
    }
  };
  return inputFile;
}

async function materializeStdinWorkflowInput(options: {
  readonly readStdinText: () => Promise<string>;
  readonly tempDir?: string;
}): Promise<{ readonly directory: string; readonly inputFile: string }> {
  const text = await options.readStdinText();
  const directory = await fs.mkdtemp(
    path.join(options.tempDir ?? os.tmpdir(), 'texra-stdin-'),
  );
  const inputFile = path.join(directory, 'stdin.tex');
  await fs.writeFile(inputFile, text, 'utf8');
  return { directory, inputFile };
}

function requireStdinWorkflowInputFile(
  flagLabel: string,
  options: WorkflowInputExpansionOptions,
): () => Promise<string> {
  if (flagLabel !== '--input' || !options.stdinInputFile) {
    throw new CliUsageError(
      `${flagLabel}: '-' is only supported for stdin workflow input`,
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

  if (trimmed === '-') {
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
  // (EACCES, EIO, …) are environment problems, not Usage errors, and must
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
  const entries: Array<readonly string[] | 'stdin'> = [];
  let stdinInputFile: (() => Promise<string>) | undefined;
  for (const spec of inputSpecs) {
    if (spec.trim() === '-') {
      stdinInputFile = requireStdinWorkflowInputFile(flagLabel, options);
      entries.push('stdin');
      continue;
    }
    entries.push(await expandWorkflowInputSpec(spec, cwd, flagLabel));
  }
  const expanded: string[] = [];
  const stdinPath = stdinInputFile
    ? normalizeCliInputPath(await stdinInputFile(), cwd)
    : undefined;
  for (const entry of entries) {
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
 * `--context` is expanded per-spec so a missing path fails as a Usage error
 * (exit 2) attributed to `--context`, rather than reaching the agent as a raw
 * ENOENT — and so the plural helper's "at least one" guard doesn't reject an
 * empty (legitimate) context list.
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
  const contextFiles = (
    await Promise.all(
      contextSpecs.map((spec) =>
        expandWorkflowInputSpec(spec, cwd, '--context'),
      ),
    )
  ).flat();
  const inputFiles = await expandWorkflowInputSpecs(
    inputSpecs,
    cwd,
    '--input',
    {
      allowEmpty: options.allowEmptyInput,
      stdinInputFile: options.stdinInputFile,
    },
  );
  return { inputFiles, contextFiles };
}
