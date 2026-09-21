// Refuted-candidate plumbing shared by the CI gate
// (scripts/check-refuted-candidates.mjs) and the pure-tier shape ratchet
// (src/test-kernel/architecture/refutedCandidatesRatchet.vitest.ts).
//
// Node built-ins only, no `typescript` import: the CI job that runs the gate
// installs nothing, the same way the guidance-refs job does. The suite owns
// the semantic half (a symbol's signature, extracted with the compiler API)
// and imports the locator below so a symbol the gate can no longer find fails
// in the pure tier instead of making the gate silently blind.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const BASELINE_FILE = 'config/ratchets/refuted-candidates.json';

export function readBaseline(repoRoot) {
  return JSON.parse(readFileSync(resolve(repoRoot, BASELINE_FILE), 'utf8'));
}

/**
 * The line range of a top-level declaration of `symbol`, 1-based and
 * inclusive. Text scanning rather than a parse, because the CI job has no
 * `typescript`: the repo is Prettier-formatted, so a top-level declaration
 * starts at column 0 and the line that closes it starts at column 0 too.
 * Throws when the symbol is absent — the ratchet's failure mode is loud, and
 * a symbol that moved is exactly what the baseline update is for.
 */
export function locateSymbol(source, symbol) {
  const lines = source.split('\n');
  const declaration = new RegExp(
    `^(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?` +
      `(?:function\\s*\\*\\s*|function\\s+|class\\s+|interface\\s+|type\\s+|enum\\s+|const\\s+|let\\s+|var\\s+)` +
      `${symbol}\\b`,
  );
  const startIndex = lines.findIndex((line) => declaration.test(line));
  if (startIndex === -1) {
    throw new Error(`no top-level declaration of \`${symbol}\``);
  }
  if (lines[startIndex].trimEnd().endsWith(';')) {
    return { startLine: startIndex + 1, endLine: startIndex + 1 };
  }
  // The line that closes the declaration holds nothing but closers, so the
  // `)` of a wrapped parameter list (`): Effect.Effect<A> {`) is not mistaken
  // for the end and the body stays inside the range.
  const closeOffset = lines
    .slice(startIndex + 1)
    .findIndex((line) => /^[})\]][\s;,)\]]*$/.test(line));
  if (closeOffset === -1) {
    throw new Error(`declaration of \`${symbol}\` has no closing line`);
  }
  return { startLine: startIndex + 1, endLine: startIndex + closeOffset + 2 };
}

/**
 * The line numbers a unified diff changes, per file, on BOTH sides: `head`
 * holds new-file lines, `base` holds old-file lines. Read from
 * `git diff --unified=0`, so a hunk header names exactly the changed lines.
 *
 * Both sides are recorded because "the PR touched this declaration" has two
 * shapes. An edit or an insertion shows up on the head side, where the
 * declaration still is. A pure deletion has no head lines at all — git emits
 * `+N,0`, whose `N` is the surviving line before the removal, not the removed
 * code — so it is only visible against the old file, where the declaration
 * still stood. A side whose hunk count is 0 contributes nothing.
 */
export function changedLinesByFile(diffText) {
  const changed = new Map();
  const sideOf = (file) => {
    const sides = changed.get(file) ?? { base: new Set(), head: new Set() };
    changed.set(file, sides);
    return sides;
  };
  const pathOf = (line, prefix) => {
    const path = line.slice(4).trim();
    return path === '/dev/null' ? undefined : path.replace(prefix, '');
  };
  let basePath;
  let headPath;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('--- ')) {
      basePath = pathOf(line, /^a\//);
      continue;
    }
    if (line.startsWith('+++ ')) {
      headPath = pathOf(line, /^b\//);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const span = (startText, countText) => {
      const start = Number(startText);
      const count = countText === undefined ? 1 : Number(countText);
      return { start, count };
    };
    const base = span(hunk[1], hunk[2]);
    const head = span(hunk[3], hunk[4]);
    if (basePath !== undefined && base.count > 0) {
      const lines = sideOf(basePath).base;
      for (let n = base.start; n < base.start + base.count; n += 1)
        lines.add(n);
    }
    if (headPath !== undefined && head.count > 0) {
      const lines = sideOf(headPath).head;
      for (let n = head.start; n < head.start + head.count; n += 1)
        lines.add(n);
    }
  }
  return changed;
}

/**
 * The line range of `symbol` in `source`, or undefined when `source` does not
 * declare it. Absence is an answer here, not a failure: a symbol is looked up
 * on both revisions, and one side legitimately lacks it when the PR adds or
 * removes the declaration. The head baseline's own symbols are separately
 * required to resolve, by `checkSymbolsResolve` in the gate.
 */
function rangeOf(source, symbol) {
  if (source === undefined) return undefined;
  try {
    return locateSymbol(source, symbol);
  } catch {
    return undefined;
  }
}

const overlaps = (lines, range) =>
  range !== undefined &&
  [...lines].some((line) => line >= range.startLine && line <= range.endLine);

/**
 * Every refuted symbol whose declaration overlaps a changed line, on either
 * revision: the head declaration against the head-side lines, and the base
 * declaration against the old-side lines, so a deletion still counts as a
 * touch. `readBaseSource` returns undefined for a file the base revision does
 * not have.
 */
export function touchedCandidates(
  baseline,
  changed,
  readSource,
  readBaseSource = () => undefined,
) {
  const touched = [];
  const seen = new Set();
  for (const candidate of baseline.candidates) {
    for (const { file, symbol } of candidate.symbols) {
      const sides = changed.get(file);
      if (!sides) continue;
      const hit =
        (sides.head.size > 0 &&
          overlaps(sides.head, rangeOf(readSource(file), symbol))) ||
        (sides.base.size > 0 &&
          overlaps(sides.base, rangeOf(readBaseSource(file), symbol)));
      if (!hit) continue;
      const key = `${candidate.id}\u0000${file}\u0000${symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      touched.push({ id: candidate.id, file, symbol });
    }
  }
  return touched;
}
