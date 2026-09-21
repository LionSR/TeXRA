// Per-file line budget (refactorability gates,
// .agents/docs/proposed/process/2026-09-20-agent-refactorability-gates.md
// section 4). 35 percent of production lines sit in files over 500 lines, and
// an oversized file is the one thing an autonomous refactor cannot hold in
// view at once: it reads the whole file to change ten lines of it. The budget
// freezes today's set so the number can only come down.
//
// Shrink-only, with one deliberate asymmetry against the effect-migration
// ratchet: a listed file that GREW fails and a file over the threshold that is
// absent from the baseline fails, but a listed file that shrank does not. An
// exact-match rule would fail every PR that deletes a line from a long file,
// which is the behaviour this budget exists to encourage. Headroom is still
// reclaimed, by the two staleness rules below: a baseline entry whose file is
// gone, and one whose file has fallen to the threshold, both fail until the
// entry is deleted.
//
// Clones the checked-in-baseline vitest pattern from
// hostAgentDeepImportRatchet.vitest.ts; the scan is a line count, so no AST.

// Node imports
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix, resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  expectRealCoverage,
  productionFilesUnder,
  REPO_ROOT,
} from '../support/repoScan';

const BASELINE_FILE = 'config/ratchets/file-size-baseline.json';

interface FileSizeBaseline {
  semantics: string;
  threshold: number;
  files: Record<string, number>;
}

/**
 * `src` plus every workspace package that has one, derived rather than listed:
 * a package added later is covered on the day it lands instead of quietly
 * sitting outside the budget.
 */
function productionRoots(): string[] {
  const packages = readdirSync(resolve(REPO_ROOT, 'packages'))
    .filter((name) => existsSync(resolve(REPO_ROOT, 'packages', name, 'src')))
    .map((name) => posix.join('packages', name, 'src'));
  return ['src', ...packages.toSorted((a, b) => a.localeCompare(b))];
}

/** Lines in `file`, `wc -l` semantics: a trailing newline ends the last line. */
function lineCount(file: string): number {
  const text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function currentLineCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const root of productionRoots()) {
    for (const file of productionFilesUnder(root)) {
      counts.set(file, lineCount(file));
    }
  }
  return counts;
}

function readBaseline(): FileSizeBaseline {
  return JSON.parse(
    readFileSync(resolve(REPO_ROOT, BASELINE_FILE), 'utf8'),
  ) as FileSizeBaseline;
}

describe('production file-size ratchet', () => {
  const baseline = readBaseline();
  const current = currentLineCounts();
  const roots = productionRoots();

  it('scans the production tree it claims to', () => {
    expectRealCoverage(roots, 1000);
  });

  it('rejects any file over the threshold that the baseline does not list', () => {
    const unlisted = [...current]
      .filter(
        ([file, lines]) =>
          lines > baseline.threshold && baseline.files[file] === undefined,
      )
      .map(([file, lines]) => `  + ${file} (${lines} lines)`)
      .toSorted((a, b) => a.localeCompare(b));
    expect(
      unlisted,
      `File(s) over ${baseline.threshold} lines that are not in ${BASELINE_FILE}:\n` +
        `${unlisted.join('\n')}\n\n` +
        `Split the file instead of widening ${BASELINE_FILE}.`,
    ).toEqual([]);
  });

  it('rejects growth in any file the baseline lists', () => {
    const grown = Object.entries(baseline.files)
      .filter(([file, budget]) => (current.get(file) ?? 0) > budget)
      .map(([file, budget]) => `  ${file}: ${budget} -> ${current.get(file)}`)
      .toSorted((a, b) => a.localeCompare(b));
    expect(
      grown,
      `File(s) that grew past their budget in ${BASELINE_FILE}:\n` +
        `${grown.join('\n')}\n\n` +
        `Move the new code out of the file; do not raise the budget.`,
    ).toEqual([]);
  });

  it('rejects baseline entries whose file is gone or has fallen to the threshold (stale headroom)', () => {
    const stale = Object.keys(baseline.files)
      .filter((file) => (current.get(file) ?? 0) <= baseline.threshold)
      .map((file) =>
        current.has(file)
          ? `  - ${file} (now ${current.get(file)} lines)`
          : `  - ${file} (deleted)`,
      )
      .toSorted((a, b) => a.localeCompare(b));
    expect(
      stale,
      `Stale entr(ies) in ${BASELINE_FILE}:\n${stale.join('\n')}\n\n` +
        `Remove them so they cannot absorb a future oversized file.`,
    ).toEqual([]);
  });

  it('keeps the baseline sorted by path', () => {
    const keys = Object.keys(baseline.files);
    expect(keys, `${BASELINE_FILE} files`).toEqual(
      keys.toSorted((a, b) => a.localeCompare(b)),
    );
  });
});
