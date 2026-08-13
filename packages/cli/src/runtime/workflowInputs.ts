import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { glob, hasMagic } from 'glob';

import { CliUsageError } from '@cli/runtime/cliContext';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { tryPlatform } from '@platform/platform';
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import type { Disposable } from '@platform/interfaces';
import { unique } from '@utils/core';
// toPosixPath also trims and resolves `.`/`..` segments beyond a bare slash
// swap; safe at both call sites below since the input is always a relative
// path already validated by isStrictlyWithin or path.relative.
import {
  isPathWithin,
  isStrictlyWithin,
  toPosixPath,
} from '@utils/core/pathCore';
import type { Stats } from 'node:fs';

const STDIN_INPUT_TOKEN = '-';
// LaTeX derives auxiliary filenames from the input basename; leading-dot
// job names can be rejected by TeX's file-open policy when it writes `.aux`.
const STDIN_TEMP_PREFIX = 'texra-stdin-';
const STDIN_TEMP_DIR_PATTERN = /^texra-stdin-\d+-[A-Za-z0-9]{6}$/;
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
  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(cwd, candidate);
}

function normalizeCliInputPath(candidate: string, cwd: string): string {
  const absolutePath = resolveAgainstCwd(candidate, cwd);
  return isStrictlyWithin(cwd, absolutePath)
    ? toPosixPath(path.relative(cwd, absolutePath))
    : absolutePath;
}

function normalizeCliInputPathForRun(
  candidate: string,
  cwd: string,
  flagLabel: string,
  options: WorkflowInputExpansionOptions,
): string {
  if (
    options.requireWorkspaceFiles === true &&
    !isPathWithin(cwd, resolveAgainstCwd(candidate, cwd))
  ) {
    throw new CliUsageError(
      `${flagLabel}: file is outside --cwd: ${candidate}`,
    );
  }
  return normalizeCliInputPath(candidate, cwd);
}

function isStdinWorkflowInputSpec(inputSpec: string): boolean {
  return inputSpec.trim() === STDIN_INPUT_TOKEN;
}

export interface WorkflowInputExpansionOptions {
  readonly allowEmpty?: boolean;
  readonly requireWorkspaceFiles?: boolean;
  readonly stdinInputFile?: () => Promise<string>;
}

type WorkflowInputExpansionEntry = readonly string[] | 'stdin';

interface PreparedWorkflowInputExpansion {
  readonly entries: WorkflowInputExpansionEntry[];
  readonly flagLabel: string;
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

export function isMaterializedStdinWorkflowInputPath(
  inputPath: string,
): boolean {
  const normalized = toPosixPath(inputPath);
  const parent = path.posix.basename(path.posix.dirname(normalized));
  return (
    path.posix.basename(normalized) === STDIN_WORKFLOW_INPUT_BASENAME &&
    STDIN_TEMP_DIR_PATTERN.test(parent)
  );
}

export function createStdinWorkflowInputMaterializer(options: {
  readonly readStdinText: () => Promise<string>;
  readonly tempDir: string;
}): StdinWorkflowInputMaterializer {
  let materialized: Promise<string> | undefined;
  let materializedPath: string | undefined;
  let shutdownCleanup: Disposable | undefined;
  let cleanupStarted = false;
  let cleanupPromise: Promise<void> | undefined;
  const inputFile = (() => {
    materialized ??= materializeStdinWorkflowInput(options).then(
      (inputPath) => {
        materializedPath = inputPath;
        if (cleanupStarted) {
          void fs
            .rm(path.dirname(inputPath), { recursive: true, force: true })
            .catch(() => undefined);
        }
        return inputPath;
      },
    );
    return materialized;
  }) as StdinWorkflowInputMaterializer;
  inputFile.cleanup = async () => {
    cleanupStarted = true;
    cleanupPromise ??= (async () => {
      shutdownCleanup?.dispose();
      shutdownCleanup = undefined;
      if (materializedPath) {
        await fs.rm(path.dirname(materializedPath), {
          recursive: true,
          force: true,
        });
      }
    })();
    await cleanupPromise;
  };
  shutdownCleanup = tryPlatform()?.lifecycle.onShutdown(
    SHUTDOWN_PHASE.BEFORE,
    inputFile.cleanup,
  );
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
  const inputDir = await fs.mkdtemp(
    path.join(options.tempDir, `${STDIN_TEMP_PREFIX}${process.pid}-`),
  );
  const inputFile = path.join(inputDir, STDIN_WORKFLOW_INPUT_BASENAME);
  try {
    await fs.writeFile(inputFile, text, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    await fs.rm(inputDir, { recursive: true, force: true }).catch(() => {
      // Preserve the original write failure for the caller.
    });
    throw error;
  }
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
 * paths it resolves to. The stdin token is resolved by
 * `prepareWorkflowInputExpansion` before it gets here, so it never reaches
 * this function.
 *
 * `flagLabel` is the CLI flag name (e.g. `--input`, `--context`) used in
 * Usage-error messages so a missing file is attributed to the right flag.
 * Defaults to `--input` for the common case; callers that pass context paths
 * (multi-agent `--context`) should override.
 */
async function expandWorkflowInputSpec(
  inputSpec: string,
  cwd: string,
  flagLabel: string = '--input',
  options: WorkflowInputExpansionOptions = {},
): Promise<string[]> {
  const trimmed = inputSpec.trim();
  if (!trimmed) return [];

  const normalizeMatches = (matches: string[]): string[] =>
    matches
      .sort()
      .map((match) =>
        normalizeCliInputPathForRun(match, cwd, flagLabel, options),
      );

  const absolutePath = resolveAgainstCwd(trimmed, cwd);
  // Prefer an exact existing path even when its valid filename contains glob
  // syntax. Windows glob mode deliberately has no backslash escape channel.
  let stats: Stats | null = null;
  try {
    stats = await fs.stat(absolutePath);
  } catch (error: unknown) {
    if (!isFileNotFoundError(error) && !isNotADirectoryError(error)) {
      throw error;
    }
  }

  const globOptions = workflowInputGlobOptions(process.platform);
  if (!stats && hasMagic(trimmed, globOptions)) {
    const isAbsolute = path.isAbsolute(trimmed);
    const matches = await glob(trimmed, {
      cwd: isAbsolute ? undefined : cwd,
      absolute: isAbsolute,
      nodir: true,
      ...globOptions,
    });
    if (matches.length === 0) {
      throw new CliUsageError(`${flagLabel}: no files matched: ${trimmed}`);
    }
    return normalizeMatches(matches);
  }

  if (stats?.isDirectory()) {
    // Validate the directory itself before globbing its contents.
    void normalizeCliInputPathForRun(trimmed, cwd, flagLabel, options);
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
    return normalizeMatches(matches);
  }

  // Fail fast with a Usage error (exit 2) instead of paying full platform
  // init + agent loading just to ENOENT inside the agent run (exit 1).
  if (!stats) {
    throw new CliUsageError(`${flagLabel}: file not found: ${trimmed}`);
  }
  return [normalizeCliInputPathForRun(trimmed, cwd, flagLabel, options)];
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
    entries.push(await expandWorkflowInputSpec(spec, cwd, flagLabel, options));
  }
  return { entries, flagLabel, stdinInputFile };
}

async function finishWorkflowInputExpansion(
  prepared: PreparedWorkflowInputExpansion,
  cwd: string,
  options: WorkflowInputExpansionOptions,
): Promise<string[]> {
  const expanded: string[] = [];
  const stdinPath = prepared.stdinInputFile
    ? normalizeCliInputPathForRun(
        await prepared.stdinInputFile(),
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
    throw new CliUsageError('At least one workflow input file is required.');
  }
  return deduped;
}

export interface ExpandedRunInputs {
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  /** True only when this invocation expanded the literal `-` stdin token. */
  readonly hasMaterializedStdinInput?: boolean;
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
    readonly requireWorkspaceFiles?: boolean;
    readonly stdinInputFile?: () => Promise<string>;
  } = {},
): Promise<ExpandedRunInputs> {
  if (
    inputSpecs.some(isStdinWorkflowInputSpec) &&
    contextSpecs.some(isStdinWorkflowInputSpec)
  ) {
    throw new CliUsageError(
      'Use `-` for either --input or --context, not both; stdin can only be read once.',
    );
  }

  const shared = {
    requireWorkspaceFiles: options.requireWorkspaceFiles,
    stdinInputFile: options.stdinInputFile,
  };
  const inputExpansion = await prepareWorkflowInputExpansion(
    inputSpecs,
    cwd,
    '--input',
    shared,
  );
  const contextExpansion = await prepareWorkflowInputExpansion(
    contextSpecs,
    cwd,
    '--context',
    shared,
  );

  const inputFiles = await finishWorkflowInputExpansion(inputExpansion, cwd, {
    ...shared,
    allowEmpty: options.allowEmptyInput,
  });
  const contextFiles = await finishWorkflowInputExpansion(
    contextExpansion,
    cwd,
    { ...shared, allowEmpty: true },
  );
  return { inputFiles, contextFiles };
}

/**
 * Own the stdin-temp-file lifecycle for headless runs that accept --input /
 * --context. Callers get already-expanded paths; this module creates and
 * removes the temporary stdin file whether expansion, execution, or output
 * handling fails.
 */
export async function withExpandedRunInputs<T>(
  inputSpecs: readonly string[],
  contextSpecs: readonly string[],
  cwd: string,
  options: {
    readonly readStdinText: () => Promise<string>;
    readonly allowEmptyInput?: boolean;
    readonly requireWorkspaceFiles?: boolean;
  },
  run: (inputs: ExpandedRunInputs) => Promise<T>,
): Promise<T> {
  const stdinInputFile = createStdinWorkflowInputMaterializer({
    readStdinText: options.readStdinText,
    tempDir: cwd,
  });
  try {
    const inputs = await expandRunInputs(inputSpecs, contextSpecs, cwd, {
      allowEmptyInput: options.allowEmptyInput,
      requireWorkspaceFiles: options.requireWorkspaceFiles,
      stdinInputFile,
    });
    return await run({
      ...inputs,
      hasMaterializedStdinInput: [...inputSpecs, ...contextSpecs].some(
        isStdinWorkflowInputSpec,
      ),
    });
  } finally {
    await stdinInputFile.cleanup();
  }
}
