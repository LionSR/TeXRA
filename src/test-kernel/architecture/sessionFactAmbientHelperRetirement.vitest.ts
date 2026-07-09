// Node imports
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

const ALLOWED_PRODUCTION_REFERENCES = [] as const;

const SCAN_ROOTS = [
  'packages/cli/src',
  'packages/desktop/src',
  'packages/extension/src',
  'src',
] as const;

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;
const RETIRED_AMBIENT_HELPER_SYMBOL = /\bemitRuntimeEvent\b/;

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

function referencesEmitRuntimeEvent(file: string): boolean {
  const source = stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
  return RETIRED_AMBIENT_HELPER_SYMBOL.test(source);
}

describe('ambient session-fact helper retirement', () => {
  it('keeps the retired ambient session-fact helper out of production code', () => {
    const references = SCAN_ROOTS.flatMap(sourceFilesUnder)
      .filter(referencesEmitRuntimeEvent)
      .toSorted();

    expect(references).toEqual([...ALLOWED_PRODUCTION_REFERENCES].toSorted());
  });

  it('actually scans the production source roots', () => {
    const scanned = SCAN_ROOTS.reduce(
      (total, root) => total + sourceFilesUnder(root).length,
      0,
    );
    expect(scanned).toBeGreaterThan(100);
  });
});
