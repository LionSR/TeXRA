// Node imports
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

const RETIRED_MODULE =
  'src/shared/progressView/backend/events/ProgressEventHandler.ts';
const RETIRED_EXTENSION_PROGRESS_MODULE =
  'packages/extension/src/frontend/events/extensionProgressEvents.ts';
const RETIRED_SYMBOL = /\bProgressEventHandler\b/;

const SCAN_ROOTS = [
  'packages/cli/src',
  'packages/desktop/src',
  'packages/extension/src',
  'src',
] as const;

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;

function toRepoPath(path: string): string {
  return relative(REPO_ROOT, resolve(REPO_ROOT, path)).replaceAll('\\', '/');
}

function sourceFilesUnder(root: string): string[] {
  const absoluteRoot = resolve(REPO_ROOT, root);
  let entries: string[];
  try {
    entries = readdirSync(absoluteRoot, { recursive: true }) as string[];
  } catch {
    return [];
  }

  return entries
    .filter((entry) => SOURCE_FILE.test(entry) && !entry.endsWith('.d.ts'))
    .map((entry) => toRepoPath(join(absoluteRoot, entry)))
    .filter((file) => !file.startsWith('src/test-kernel/'));
}

function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const commentStart = line.indexOf('//');
      return commentStart === -1 ? line : line.slice(0, commentStart);
    })
    .join('\n');
}

function mentionsRetiredSymbol(file: string): boolean {
  const source = stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
  return RETIRED_SYMBOL.test(source);
}

describe('ProgressEventHandler retirement boundary', () => {
  it('removes the retired ProgressEventHandler module', () => {
    expect(existsSync(resolve(REPO_ROOT, RETIRED_MODULE))).toBe(false);
  });

  it('removes the retired extension progress-event adapter module', () => {
    expect(
      existsSync(resolve(REPO_ROOT, RETIRED_EXTENSION_PROGRESS_MODULE)),
    ).toBe(false);
  });

  it('removes the ProgressEventHandler class name from production sources', () => {
    const offenders = SCAN_ROOTS.flatMap(sourceFilesUnder)
      .filter(mentionsRetiredSymbol)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  it('actually scans the production source roots', () => {
    const scanned = SCAN_ROOTS.reduce(
      (total, root) => total + sourceFilesUnder(root).length,
      0,
    );
    expect(scanned).toBeGreaterThan(100);
  });
});
