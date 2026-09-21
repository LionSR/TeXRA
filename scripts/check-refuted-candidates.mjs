#!/usr/bin/env node
// Refuted-candidate CI gate — refactorability gates
// .agents/docs/proposed/process/2026-09-20-agent-refactorability-gates.md
// section 2, the second of its two enforcement points.
//
// config/ratchets/refuted-candidates.json records the refactor candidates
// that were investigated, costed and refused, so an autonomous pass stops
// re-proposing them. The pure-tier suite
// (src/test-kernel/architecture/refutedCandidatesRatchet.vitest.ts) pins each
// symbol's shape; it cannot read a pull-request body, which is what this
// script adds: a PR whose diff touches a refused declaration must cite that
// candidate's ruling id in its body.
//
// The gate never forbids the change. It requires the author to have read the
// ruling and to say so, and a candidate that lands on new evidence updates or
// deletes its entry in the same PR.
//
// Node built-ins and `git` only, so the workflow that runs it installs
// nothing.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  BASELINE_FILE,
  changedLinesByFile,
  locateSymbol,
  readBaseline,
  touchedCandidates,
} from './refutedCandidates.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (file) => readFileSync(resolve(rootDir, file), 'utf8');

const { values } = parseArgs({
  options: { base: { type: 'string' } },
});

const baseline = readBaseline(rootDir);

/** Every symbol resolves, or the gate is blind and says so. */
function checkSymbolsResolve() {
  const broken = [];
  for (const candidate of baseline.candidates) {
    for (const { file, symbol } of candidate.symbols) {
      if (!existsSync(resolve(rootDir, file))) {
        broken.push(`${candidate.id}: ${file} does not exist`);
        continue;
      }
      try {
        locateSymbol(readSource(file), symbol);
      } catch (error) {
        broken.push(`${candidate.id}: ${file} — ${error.message}`);
      }
    }
  }
  if (broken.length > 0) {
    console.error(
      `${BASELINE_FILE} names symbols this gate can no longer find:\n` +
        `${broken.map((line) => `  ${line}`).join('\n')}\n\n` +
        `Update the entry (or delete it, citing its ruling) so the gate keeps ` +
        `covering what it claims to.`,
    );
    process.exit(1);
  }
}

/** git's wording when the path is simply not in that revision. */
const PATH_ABSENT = /does not exist in|exists on disk, but not in/;

/**
 * `git show <rev>:<path>`, or undefined when that revision has no such file.
 * Only genuine absence returns undefined: any other `git` failure rethrows,
 * because swallowing it would drop the base side of the gate silently, which
 * is exactly the protection this function exists to provide.
 */
function showAtRevision(rev, file) {
  try {
    return execFileSync('git', ['show', `${rev}:${file}`], {
      cwd: rootDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    if (PATH_ABSENT.test(stderr)) return undefined;
    throw new Error(
      `git show ${rev}:${file} failed: ${stderr.trim() || error.message}`,
    );
  }
}

/**
 * The candidates the gate enforces: the base revision's, unioned with the
 * head's. Reading only the head baseline would let one PR delete an entry and
 * rewrite its declaration with no ruling cited, which is precisely the move
 * the gate exists to make deliberate. A deletion is legal — it just has to
 * name the id it overturns.
 */
function enforcedCandidates(base) {
  const baseText = showAtRevision(base, BASELINE_FILE);
  const baseCandidates = baseText ? JSON.parse(baseText).candidates : [];
  const merged = new Map();
  // Head metadata wins (a PR may reword a ruling), symbols are unioned, so
  // dropping one symbol from an entry hides no declaration either.
  for (const candidate of [...baseCandidates, ...baseline.candidates]) {
    const symbols = new Map(
      (merged.get(candidate.id)?.symbols ?? []).map((entry) => [
        `${entry.file}#${entry.symbol}`,
        entry,
      ]),
    );
    for (const entry of candidate.symbols) {
      symbols.set(`${entry.file}#${entry.symbol}`, entry);
    }
    merged.set(candidate.id, { ...candidate, symbols: [...symbols.values()] });
  }
  return { candidates: [...merged.values()] };
}

function checkPullRequestDiff(base) {
  const enforced = enforcedCandidates(base);
  const files = [
    ...new Set(
      enforced.candidates.flatMap((candidate) =>
        candidate.symbols.map((entry) => entry.file),
      ),
    ),
  ];
  const diff = execFileSync(
    'git',
    ['diff', '--unified=0', `${base}...HEAD`, '--', ...files],
    { cwd: rootDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const touched = touchedCandidates(
    enforced,
    changedLinesByFile(diff),
    readSource,
    (file) => showAtRevision(base, file),
  );
  if (touched.length === 0) {
    console.log('No refused candidate is touched by this diff.');
    return;
  }

  const body = process.env.PR_BODY ?? '';
  const uncited = [
    ...new Set(
      touched.filter((hit) => !body.includes(hit.id)).map((h) => h.id),
    ),
  ];
  const byId = new Map(enforced.candidates.map((c) => [c.id, c]));
  for (const hit of touched) {
    console.log(`${hit.id} touched at ${hit.file}#${hit.symbol}`);
  }
  if (uncited.length === 0) {
    console.log('Every touched candidate is cited in the pull-request body.');
    return;
  }

  console.error(
    `\nThis pull request changes declarations that a ruling already refused, ` +
      `and its body cites no ruling id for them:\n\n` +
      uncited
        .map((id) => {
          const candidate = byId.get(id);
          return (
            `  ${id} — ${candidate.candidate}\n` +
            `    why it was refused: ${candidate.why}\n` +
            `    ruling: ${candidate.ruling}`
          );
        })
        .join('\n\n') +
      `\n\nRead the ruling. If the change stands on new evidence, say so in ` +
      `the PR body, cite the id, and update or delete the entry in ` +
      `${BASELINE_FILE}. If it is the refused change as specified, drop it.`,
  );
  process.exit(1);
}

checkSymbolsResolve();
if (values.base) checkPullRequestDiff(values.base);
