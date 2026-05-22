import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { glob, hasMagic } from 'glob';

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

export async function expandWorkflowInputSpec(
  inputSpec: string,
  cwd: string,
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
  const stats = await fs.stat(absolutePath).catch(() => null);
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

  return [normalizeCliInputPath(trimmed, cwd)];
}

export async function expandWorkflowInputSpecs(
  inputSpecs: readonly string[],
  cwd: string,
): Promise<string[]> {
  const expanded = (
    await Promise.all(
      inputSpecs.map((spec) => expandWorkflowInputSpec(spec, cwd)),
    )
  ).flat();
  const unique = [...new Set(expanded)];
  if (unique.length === 0) {
    throw new CliUsageError('At least one workflow input file is required.');
  }
  return unique;
}
