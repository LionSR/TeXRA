#!/usr/bin/env node
/**
 * Reject widening of the committed allowlists, config/ratchets/*.json,
 * against the point where this tree left the target branch, its merge base
 * (ratchet-base.mjs: `--base <ref>` or TEXRA_RATCHET_BASE, origin/main by
 * default). A row the target shrank after the fork is not this tree's
 * widening: git keeps the target's value for a row the branch did not touch.
 * The JSON files remain the authority; this only compares the working tree
 * with `git show <base>:<path>`, allowing new baseline files. The
 * core-quality counts have no file: check-core-quality.mjs measures them
 * against the same base.
 *
 * Rows may move, because files and modules move: each added row consumes one
 * removed row of the same file, used once. A numeric donor must carry an
 * equal or greater count; an allowlist donor must match the added item on
 * every field that is not a path; and the added row's key must be the
 * donor's with each path that differs renamed by a move in
 * `git diff --find-renames <base>` (a module specifier names the file it
 * resolves to by its trailing path, and a `module#name` names its module).
 * Retained rows cannot grow.
 * A deleted baseline file fails, unless it was empty at the base and is
 * listed in ZERO_RULES (ratchet-zero-rules.mjs), whose named checker holds
 * its rule at zero without a file; a listed file that still exists fails, so
 * no rule is read from two places. Retiring any other ratchet is an owner
 * call, made outside this check. Refuted candidates are recorded refusals,
 * which only restrict, so they are not compared.
 *
 * `config/storage/row-kinds-ever.json` runs the other way: it lists every row
 * kind a build ever stored, so it may only grow; a name the base lists and the
 * tree does not is a problem.
 */

// Node imports
import console from 'node:console';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { git, ratchetBase, renamesSince } from './ratchet-base.mjs';
import { ZERO_RULES } from './ratchet-zero-rules.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const baselineDir = 'config/ratchets';
const REFUTED_CANDIDATES = `${baselineDir}/refuted-candidates.json`;
const ROW_KINDS_EVER = 'config/storage/row-kinds-ever.json';
const isObject = (value) =>
  value != null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isFinite(value) && value >= 0;
const hasKeys = (value, keys) =>
  isObject(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const stringFields = (value, keys) =>
  keys.every((key) => typeof value[key] === 'string');

/** Decode only the shapes used by the directory, never silently omit a field. */
function readBaseline(file, text) {
  const fail = (key) => {
    throw new Error(`${file}: unknown baseline shape at ${key}`);
  };
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: invalid baseline JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (!isObject(data)) fail('$');
  const rows = new Map();
  const add = (key, value = 1) => {
    if (rows.has(key)) fail(`${key} (duplicate entry)`);
    rows.set(key, value);
  };
  const [shape] = Object.keys(data).filter((key) => key !== 'semantics');
  if (
    !hasKeys(data, ['semantics', shape]) ||
    typeof data.semantics !== 'string'
  )
    fail('$');
  const entries = data[shape];
  if (shape === 'exemptions') {
    if (!isObject(entries)) fail(shape);
    for (const [key, entry] of Object.entries(entries)) {
      if (
        !hasKeys(entry, ['count', 'reason']) ||
        !isCount(entry.count) ||
        typeof entry.reason !== 'string'
      )
        fail(`${shape}.${key}`);
      add(key, entry.count);
    }
  } else if (
    shape === 'hosts' ||
    shape === 'kernel' ||
    shape === 'readers' ||
    shape === 'names'
  ) {
    // A list per key: the deep imports per host or for the test kernel, the
    // files per row type, the names imported across a harness edge that
    // breaks the layer order.
    if (!isObject(entries)) fail(shape);
    for (const [key, items] of Object.entries(entries)) {
      if (
        !Array.isArray(items) ||
        !items.every((item) => typeof item === 'string')
      )
        fail(`${shape}.${key}`);
      for (const item of items) {
        // A name's row is its bare `module#name`, valued by its kind, so
        // `type X` -> `X` widens and `X` -> `type X` narrows.
        const bare = item.replace(/^type /, '');
        if (shape === 'names')
          add(
            JSON.stringify([key, bare]),
            bare === item ? 'value' : 'type-only',
          );
        else add(JSON.stringify([key, item]), `${shape}:${key}`);
      }
    }
  } else {
    if (!Array.isArray(entries)) fail(shape);
    for (const entry of entries) {
      if (shape === 'edges') {
        if (
          !hasKeys(entry, ['from', 'to', 'kind']) ||
          !stringFields(entry, ['from', 'to']) ||
          !['type-only', 'value'].includes(entry.kind)
        )
          fail(shape);
        add(JSON.stringify([entry.from, entry.to]), entry.kind);
      } else if (shape === 'sites' || shape === 'findings') {
        const fields =
          shape === 'sites'
            ? ['file', 'form', 'specifier']
            : ['file', 'category', 'kind', 'name'];
        if (!hasKeys(entry, fields) || !stringFields(entry, fields))
          fail(shape);
        // The donor signature: every field that is not a path.
        const fixed =
          shape === 'sites'
            ? [entry.form]
            : [entry.category, entry.kind, entry.name];
        add(
          JSON.stringify(fields.map((field) => entry[field])),
          JSON.stringify(fixed),
        );
      } else if (shape === 'candidates') {
        const fields = ['id', 'candidate', 'why', 'ruling'];
        if (
          !hasKeys(entry, [...fields, 'symbols']) ||
          !stringFields(entry, fields) ||
          !Array.isArray(entry.symbols)
        )
          fail(shape);
        for (const symbol of entry.symbols) {
          const symbolFields = ['file', 'symbol', 'signature'];
          if (
            !hasKeys(symbol, symbolFields) ||
            !stringFields(symbol, symbolFields)
          )
            fail(`${shape}.${entry.id}.symbols`);
        }
      } else fail(shape);
    }
    // An empty unknown list must fail too.
    if (!['edges', 'sites', 'findings', 'candidates'].includes(shape))
      fail(shape);
  }
  return { shape, rows };
}

/** Whether `donor`, a removed row's value, may pay for an added `value`. */
function donates(donor, value) {
  if (typeof value === 'number')
    return typeof donor === 'number' && donor >= value;
  // An architecture edge: a value edge may move as either kind.
  if (value === 'type-only' || value === 'value')
    return donor === value || (donor === 'value' && value === 'type-only');
  return donor === value;
}

/** Every file the tree moved since the base, as `[from, to]` stems. */
const renamedStems = (base) =>
  renamesSince(base).map((pair) =>
    pair.map((file) => file.replace(/\.[cm]?[jt]sx?$/, '')),
  );

/** Whether `name` (a path or an `@alias/` specifier) names the file `stem`. */
function names(name, stem) {
  const tail = name.replace(/\.[cm]?[jt]sx?$/, '').replace(/^@/, '');
  return stem === tail || stem.endsWith(`/${tail}`);
}

/** Whether `added` is `removed`'s key moved: every part that differs is a
 *  path the tree renamed. */
function moved(removed, added, renames) {
  const parts = (key) => (key.startsWith('[') ? JSON.parse(key) : [key]);
  const from = parts(removed);
  const to = parts(added);
  // A `module#name` part moves with its module; the name stays.
  const split = (part) => {
    const at = part.lastIndexOf('#');
    return at < 0 ? [part, ''] : [part.slice(0, at), part.slice(at)];
  };
  return (
    from.length === to.length &&
    from.every((part, i) => {
      if (part === to[i]) return true;
      const [path, name] = split(part);
      const [nextPath, nextName] = split(to[i]);
      return (
        name === nextName &&
        renames.some(([old, next]) => names(path, old) && names(nextPath, next))
      );
    })
  );
}

/** A removed row pays for at most one added row of the same file, and only
 *  for the row it became when its file moved. */
function checkBaseline(file, previous, current, renames) {
  if (previous.shape !== current.shape)
    throw new Error(
      `${file}: baseline shape changed: ${previous.shape} → ${current.shape}`,
    );
  const removed = [...previous.rows].filter(([key]) => !current.rows.has(key));
  const problems = [];
  const added = [];
  for (const [key, value] of current.rows) {
    if (!previous.rows.has(key)) {
      added.push([key, value]);
      continue;
    }
    const old = previous.rows.get(key);
    const grows =
      typeof value === 'number'
        ? value > old
        : old === 'type-only' && value === 'value';
    if (grows)
      problems.push(`${file}: ${current.shape}.${key}: ${old} → ${value}`);
  }
  // Strongest rows first, each taking the weakest sufficient donor, so a pure
  // rename passes whatever the order, even when several rows move at once.
  const rank = (v) =>
    typeof v === 'number' ? v : v === 'value' ? 2 : v === 'type-only' ? 1 : 0;
  removed.sort((a, b) => rank(a[1]) - rank(b[1]));
  for (const [key, value] of added.toSorted(
    (a, b) => rank(b[1]) - rank(a[1]),
  )) {
    const donor = removed.findIndex(
      ([oldKey, old]) => donates(old, value) && moved(oldKey, key, renames),
    );
    if (donor >= 0) removed.splice(donor, 1);
    else
      problems.push(
        `${file}: ${current.shape}.${key}: absent → ${value} (new allowance; a move needs its file's rename in the diff, staged)`,
      );
  }
  return problems;
}

function main() {
  const { values } = parseArgs({ options: { base: { type: 'string' } } });
  const { target, base } = ratchetBase(values.base);
  // A git-show failure propagates; only a path absent from the base's tree is
  // a new baseline. An allowlist is a top-level file of the directory.
  const isBaseline = (file) => file.endsWith('.json');
  const baseFiles = new Set(
    git('ls-tree', '--name-only', base, '--', `${baselineDir}/`)
      .trim()
      .split('\n')
      .filter(isBaseline),
  );
  const files = existsSync(path.join(rootDir, baselineDir))
    ? readdirSync(path.join(rootDir, baselineDir))
        .filter(isBaseline)
        .map((name) => `${baselineDir}/${name}`)
        .toSorted()
    : [];
  const problems = [];
  const renames = renamedStems(base);
  let newFiles = 0;
  for (const file of files) {
    const current = readBaseline(
      file,
      readFileSync(path.join(rootDir, file), 'utf8'),
    );
    if (!baseFiles.has(file)) {
      newFiles += 1;
      continue;
    }
    const previous = readBaseline(file, git('show', `${base}:${file}`));
    // Refuted candidates record refusals; adding one only restricts.
    if (file !== REFUTED_CANDIDATES)
      problems.push(...checkBaseline(file, previous, current, renames));
  }
  // Absent on the base only before this file's first commit.
  const kindsEver = (text) => JSON.parse(text).kinds;
  const everBefore = git(
    'ls-tree',
    '--name-only',
    base,
    '--',
    ROW_KINDS_EVER,
  ).trim()
    ? kindsEver(git('show', `${base}:${ROW_KINDS_EVER}`))
    : [];
  const everNow = new Set(
    kindsEver(readFileSync(path.join(rootDir, ROW_KINDS_EVER), 'utf8')),
  );
  for (const kind of everBefore)
    if (!everNow.has(kind))
      problems.push(`${ROW_KINDS_EVER}: ${kind} removed (the list only grows)`);
  const present = new Set(files);
  for (const file of baseFiles) {
    if (!file || present.has(file)) continue;
    if (!Object.hasOwn(ZERO_RULES, file))
      problems.push(`${file}: deleted (retiring a ratchet is an owner call)`);
    else if (readBaseline(file, git('show', `${base}:${file}`)).rows.size > 0)
      problems.push(
        `${file}: deleted with rows at the base; only an empty baseline gives way to ZERO_RULES`,
      );
  }
  for (const file of files)
    if (Object.hasOwn(ZERO_RULES, file))
      problems.push(
        `${file}: listed in ZERO_RULES (held at zero by ${ZERO_RULES[file]}); delete the file`,
      );
  if (problems.length > 0) {
    console.error(
      `ratchet-baselines: ${problems.length} widening(s) against ${target} (fork point ${base.slice(0, 10)})\n${problems.join('\n')}`,
    );
    process.exitCode = 1;
  } else
    console.log(
      `ratchet-baselines: ${files.length} files do not widen ${target} (fork point ${base.slice(0, 10)}, ${newFiles} new)`,
    );
}

try {
  main();
} catch (error) {
  console.error(`ratchet-baselines: ${error.message}`, error.cause ?? '');
  process.exitCode = 1;
}
