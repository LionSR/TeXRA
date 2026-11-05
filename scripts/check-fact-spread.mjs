// Two counts of how many places decide one fact, held shrink-only against
// the merge base with origin/main (ratchet-base.mjs). A fact decided in more files than before fails; a fall needs
// nothing. Each count is one more place a fact can be decided differently:
// a predicate evaluated in another file, a vocabulary spelled again.
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
import console from 'node:console';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Third-party imports
import ts from 'typescript';

// Local imports
import { ratchetBase, withBaseTree } from './ratchet-base.mjs';
import { walkFiles } from './walkFiles.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/** Every package's source. */
const SOURCE_DIRS = [
  'packages/harness/src',
  'packages/llm/src',
  'packages/texra/src',
  'packages/extension/src',
  'packages/desktop/src',
  'packages/cli/src',
  'packages/trace-viewer/src',
];
const SOURCE_FILE = /\.(?:ts|tsx|mts)$/;
const NOT_SOURCE = /\.d\.ts$|\.(?:test|vitest|spec)\.tsx?$/;

/** The repo-relative source files of `tree`, sorted. A directory a change
 *  adds is absent from the merge base's tree and has no files there. */
const sourceFiles = (tree) =>
  SOURCE_DIRS.filter((dir) => existsSync(path.join(tree, dir)))
    .flatMap((dir) =>
      walkFiles(path.join(tree, dir), {
        include: (file) => SOURCE_FILE.test(file) && !NOT_SOURCE.test(file),
        prune: (dir) => dir.endsWith('node_modules'),
      }).map(({ relativePath }) => `${dir}/${relativePath}`),
    )
    .toSorted();

/** The predicates whose spread is counted, as they read in source. */
const PREDICATES = [
  'Cause.hasInterrupts',
  'Cause.squash',
  'isTerminalOutcomePhase',
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
 * The counts over `tree`: files per predicate, and the overlapping pairs of
 * files, each with the members its two literal sets share (the most, when
 * the files hold several), so a rise names the pair that is new.
 */
function measure(tree) {
  const files = sourceFiles(tree);
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
      const key = [a.file, b.file].sort().join(' ~ ');
      const known = pairs.get(key);
      if (known === undefined || shared.length > known.length)
        pairs.set(key, shared);
    }
  return { spread, pairs };
}

const describePair = ([key, shared]) => `    ${key}: ${shared.join(', ')}`;

function report({ spread, pairs }, { listPairs = false } = {}) {
  const lines = [...spread].map(
    ([predicate, files]) => `  ${predicate}: ${files.length} files`,
  );
  lines.push(`  vocabulary overlap: ${pairs.size} pairs`);
  if (listPairs) lines.push(...[...pairs].map(describePair));
  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: { base: { type: 'string' }, report: { type: 'boolean' } },
  });
  const head = measure(rootDir);
  if (values.report) {
    console.log(`fact-spread at HEAD:\n${report(head, { listPairs: true })}`);
    return;
  }
  const { target, base } = ratchetBase(values.base);
  const before = await withBaseTree(base, measure);
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
    const added = [...head.pairs].filter(([key]) => !before.pairs.has(key));
    problems.push(
      `vocabulary overlap: ${head.pairs.size} pairs of files hold literal sets sharing ${SHARED_MEMBERS}+ members, merge base ${before.pairs.size}; new:\n${added.map(describePair).join('\n')}`,
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

await main();
