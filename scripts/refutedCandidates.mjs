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
      `(?:function\\s+\\*?|class\\s+|interface\\s+|type\\s+|enum\\s+|const\\s+|let\\s+|var\\s+)` +
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
 * Head-side line numbers a unified diff changes, per file. Read from
 * `git diff --unified=0`, so a hunk header names exactly the changed lines; a
 * pure deletion (`+0`) is attributed to the line it was removed from, which
 * is what "the PR touched this symbol" has to mean for deleted code.
 */
export function changedLinesByFile(diffText) {
  const changed = new Map();
  let file;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      file = path === '/dev/null' ? undefined : path.replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || file === undefined) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = changed.get(file) ?? new Set();
    for (let n = start; n < start + Math.max(count, 1); n += 1) lines.add(n);
    changed.set(file, lines);
  }
  return changed;
}

/** Every refuted symbol whose declaration overlaps a changed line. */
export function touchedCandidates(baseline, changed, readSource) {
  const touched = [];
  for (const candidate of baseline.candidates) {
    for (const { file, symbol } of candidate.symbols) {
      const lines = changed.get(file);
      if (!lines || lines.size === 0) continue;
      const { startLine, endLine } = locateSymbol(readSource(file), symbol);
      const overlaps = [...lines].some(
        (line) => line >= startLine && line <= endLine,
      );
      if (overlaps) touched.push({ id: candidate.id, file, symbol });
    }
  }
  return touched;
}
