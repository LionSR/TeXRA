import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { glob, hasMagic } from 'glob';

import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';

import { CliUsageError } from '../../runtime/cliContext';

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
): Promise<string[]> {
  const trimmed = inputSpec.trim();
  if (!trimmed) return [];

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
): Promise<string[]> {
  const expanded = (
    await Promise.all(
      inputSpecs.map((spec) => expandWorkflowInputSpec(spec, cwd, flagLabel)),
    )
  ).flat();
  const unique = [...new Set(expanded)];
  if (unique.length === 0) {
    throw new CliUsageError('At least one workflow input file is required.');
  }
  return unique;
}
