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

const ALLOWED_PRODUCTION_REFERENCES = [
  'packages/extension/src/commands/agent/followUpCommand.ts',
  'packages/extension/src/commands/housekeeping/streamEventUtils.ts',
  'src/agent/followUp/ToolUseFollowUp.ts',
  'src/agent/runtime/ExecutionSubscriptionBinder.ts',
  'src/agent/runtime/emitRuntimeEvent.ts',
  'src/agent/runtime/executeAgent.ts',
  'src/tools/approval/toolEditApproval.ts',
  'src/tools/inquiry/inquiryContinuation.ts',
] as const;

const SCAN_ROOTS = [
  'packages/cli/src',
  'packages/desktop/src',
  'packages/extension/src',
  'src',
] as const;

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;
const EMIT_RUNTIME_EVENT_SYMBOL = /\bemitRuntimeEvent\b/;

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
  return EMIT_RUNTIME_EVENT_SYMBOL.test(source);
}

describe('emitRuntimeEvent boundary', () => {
  it('keeps the ambient session-fact helper surface explicitly bounded', () => {
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
