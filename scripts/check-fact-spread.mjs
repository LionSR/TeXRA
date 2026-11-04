// Two counts of how many places decide one fact, held shrink-only against
// the merge base with origin/main (ratchet-base.mjs), as the core-quality
// rules are. A fact decided in more files than before fails; a fall needs
// nothing. Both come from the design note
// .agents/docs/proposed/architecture/2026-11-03-one-fact-one-representation.md,
// whose "Checks" section names them.
//
// - predicate spread: for each predicate in PREDICATES, the number of
//   source files that contain it. A predicate that decides "did it stop",
//   "is it working here" or "who is the parent" in one more file is one
//   more place that can disagree.
// - vocabulary overlap: the pairs of string-literal sets (`Schema.Literals(
//   [...])` and `[...] as const`) in different files that share three or
//   more members: one vocabulary spelled twice.
//
//   node scripts/check-fact-spread.mjs              check against origin/main
//   node scripts/check-fact-spread.mjs --base <ref>  check against the merge base with <ref>
//   node scripts/check-fact-spread.mjs --report      print the head's counts

// Node imports
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Third-party imports
import ts from 'typescript';

// Local imports
import { SOURCE_DIRS, sourceFiles } from './core-quality-measure.mjs';
import { git, ratchetBase } from './ratchet-base.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/** The predicates whose spread is counted, as they read in source. */
const PREDICATES = [
  'Cause.hasInterrupts',
  'Cause.squash',
  'isTerminalOutcomePhase',
  'isActivePhase',
  'isLiveRun',
  'ownedHere',
  'readOnly',
  'parentId',
  'withPerKeyLane',
  'toErrorMessage',
];

/** Members a pair of literal sets must share to count as one vocabulary. */
const SHARED_MEMBERS = 3;

/** Each predicate's pattern: an identifier matches whole, a dotted one as written. */
const MATCHERS = new Map(
  PREDICATES.map((predicate) => [
    predicate,
    new RegExp(
      predicate.includes('.')
        ? predicate.replaceAll('.', '\\.')
        : `\\b${predicate}\\b`,
    ),
  ]),
);

/** The string members of an array literal, or null when any element is not one. */
function stringMembers(node) {
  if (!ts.isArrayLiteralExpression(node)) return null;
  const members = [];
  for (const element of node.elements) {
    if (!ts.isStringLiteral(element)) return null;
    members.push(element.text);
  }
  return members;
}

/** The literal sets `text` declares: `Schema.Literals([...])` and `[...] as const`. */
function literalSets(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sets = [];
  const visit = (node) => {
    let members = null;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'Literals' &&
      node.arguments.length === 1
    )
      members = stringMembers(node.arguments[0]);
    else if (
      ts.isAsExpression(node) &&
      ts.isTypeReferenceNode(node.type) &&
      ts.isIdentifier(node.type.typeName) &&
      node.type.typeName.text === 'const'
    )
      members = stringMembers(node.expression);
    if (members !== null && members.length >= SHARED_MEMBERS)
      sets.push({ file, members: new Set(members) });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sets;
}

/**
 * The counts over `tree`: files per predicate, and the overlapping pairs
 * keyed by their two files and the members they share, so a rise names
 * the pair that rose.
 */
function measure(tree) {
  const files = sourceFiles(tree, SOURCE_DIRS);
  const spread = new Map(PREDICATES.map((predicate) => [predicate, []]));
  const sets = [];
  for (const file of files) {
    const text = readFileSync(path.join(tree, file), 'utf8');
    for (const [predicate, pattern] of MATCHERS)
      if (pattern.test(text)) spread.get(predicate).push(file);
    sets.push(...literalSets(file, text));
  }
  const pairs = new Map();
  for (let i = 0; i < sets.length; i += 1)
    for (let j = i + 1; j < sets.length; j += 1) {
      const a = sets[i];
      const b = sets[j];
      if (a.file === b.file) continue;
      const shared = [...a.members].filter((m) => b.members.has(m)).sort();
      if (shared.length < SHARED_MEMBERS) continue;
      const [first, second] = [a.file, b.file].sort();
      const key = `${first} ~ ${second}: ${shared.join(', ')}`;
      pairs.set(key, { first, second, shared });
    }
  return { spread, pairs };
}

/** The counts over the base commit's tree, extracted like core-quality's. */
function measureBase(base) {
  const dir = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'fact-spread-base-')),
  );
  try {
    const tar = path.join(dir, 'base.tar');
    git('archive', '--format=tar', '--output', tar, base);
    const tree = path.join(dir, 'tree');
    mkdirSync(tree);
    execFileSync('tar', ['-xf', tar, '-C', tree]);
    return measure(tree);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function report({ spread, pairs }, { listPairs = false } = {}) {
  const lines = [...spread].map(
    ([predicate, files]) => `  ${predicate}: ${files.length} files`,
  );
  lines.push(`  vocabulary overlap: ${pairs.size} pairs`);
  if (listPairs) lines.push(...[...pairs.keys()].map((key) => `    ${key}`));
  return lines.join('\n');
}

function main() {
  const { values } = parseArgs({
    options: { base: { type: 'string' }, report: { type: 'boolean' } },
  });
  const head = measure(rootDir);
  if (values.report) {
    console.log(`fact-spread at HEAD:\n${report(head, { listPairs: true })}`);
    return;
  }
  const { target, base } = ratchetBase(values.base);
  const before = measureBase(base);
  const problems = [];
  for (const [predicate, files] of head.spread) {
    const baseFiles = before.spread.get(predicate);
    if (files.length <= baseFiles.length) continue;
    const added = files.filter((file) => !baseFiles.includes(file));
    problems.push(
      `predicate spread: ${predicate} is decided in ${files.length} files, merge base ${baseFiles.length}; new: ${added.join(', ')}`,
    );
  }
  if (head.pairs.size > before.pairs.size) {
    const added = [...head.pairs.keys()].filter(
      (key) => !before.pairs.has(key),
    );
    problems.push(
      `vocabulary overlap: ${head.pairs.size} pairs of literal sets share ${SHARED_MEMBERS}+ members, merge base ${before.pairs.size}; new:\n${added.map((key) => `    ${key}`).join('\n')}`,
    );
  }
  if (problems.length > 0) {
    console.error(
      `fact-spread: ${problems.length} rise(s) against ${target} (fork point ${base.slice(0, 10)})\n${problems.join('\n')}\nA fact decided in one more place is one more place that can disagree: decide it where it already is, or delete the older site in the same PR.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `fact-spread: no rise against ${target} (fork point ${base.slice(0, 10)})\n${report(head)}`,
  );
}

main();
