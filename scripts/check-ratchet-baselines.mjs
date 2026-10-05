#!/usr/bin/env node
/**
 * Reject widening of config/ratchets/** against TEXRA_RATCHET_BASE (default:
 * origin/main). The JSON files remain the authority; this only compares the
 * working tree with `git show <base>:<path>`, allowing new baseline files.
 *
 * Rows may move, because files and modules move (M8, `--move`): each added
 * row consumes one removed row of the same file, used once. A numeric donor
 * must carry an equal or greater count; an allowlist donor must match the
 * added item on every field that is not a path. Retained rows cannot grow.
 * A deleted baseline file retires its ratchet and fails; that is an owner
 * call, made outside this check. Refuted candidates are recorded refusals,
 * which only restrict, so they are not compared.
 */

// Node imports
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const baselineDir = 'config/ratchets';
const base = process.env.TEXRA_RATCHET_BASE ?? 'origin/main';
const REFUTED_CANDIDATES = `${baselineDir}/refuted-candidates.json`;
const git = (...args) =>
  execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    throw new Error(`${file}: invalid baseline JSON: ${error.message}`);
  }
  if (!isObject(data)) fail('$');
  const rows = new Map();
  const add = (key, value = 1) => {
    if (rows.has(key)) fail(`${key} (duplicate entry)`);
    rows.set(key, value);
  };
  if (Object.values(data).every(isCount)) {
    return {
      shape: 'counts',
      rows: new Map(Object.entries(data)),
    };
  }
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
  } else if (shape === 'hosts') {
    if (!isObject(entries)) fail(shape);
    for (const [host, items] of Object.entries(entries)) {
      if (
        !Array.isArray(items) ||
        !items.every((item) => typeof item === 'string')
      )
        fail(`${shape}.${host}`);
      for (const item of items)
        add(JSON.stringify([host, item]), `host:${host}`);
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

/** A removed row pays for at most one added row of the same file. */
function checkBaseline(file, previous, current) {
  if (previous.shape !== current.shape)
    throw new Error(
      `${file}: baseline shape changed: ${previous.shape} → ${current.shape}`,
    );
  const removed = [...previous.rows]
    .filter(([key]) => !current.rows.has(key))
    .map(([, value]) => value);
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
  removed.sort((a, b) => rank(a) - rank(b));
  for (const [key, value] of added.toSorted(
    (a, b) => rank(b[1]) - rank(a[1]),
  )) {
    const donor = removed.findIndex((old) => donates(old, value));
    if (donor >= 0) removed.splice(donor, 1);
    else
      problems.push(
        `${file}: ${current.shape}.${key}: absent → ${value} (new allowance)`,
      );
  }
  return problems;
}

/** Walk every file, including nested baselines, without an extension filter. */
function baselineFiles(dir) {
  return readdirSync(path.join(rootDir, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const file = `${dir}/${entry.name}`;
      return entry.isDirectory() ? baselineFiles(file) : [file];
    },
  );
}

function main() {
  // ls-tree failing is a missing base, not a new file. A later git-show failure
  // also propagates; only a path absent from this tree is a new baseline.
  try {
    git('rev-parse', '--verify', `${base}^{commit}`);
  } catch {
    throw new Error(
      `base ${base} is not available locally; run \`git fetch origin\` (or set TEXRA_RATCHET_BASE)`,
    );
  }
  const baseFiles = new Set(
    git('ls-tree', '-r', '--name-only', base, '--', baselineDir)
      .trim()
      .split('\n'),
  );
  const files = existsSync(path.join(rootDir, baselineDir))
    ? baselineFiles(baselineDir).toSorted()
    : [];
  const problems = [];
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
      problems.push(...checkBaseline(file, previous, current));
  }
  const present = new Set(files);
  for (const file of baseFiles)
    if (file && !present.has(file))
      problems.push(`${file}: deleted (retiring a ratchet is an owner call)`);
  if (problems.length > 0) {
    console.error(
      `ratchet-baselines: ${problems.length} widening(s) against ${base}\n${problems.join('\n')}`,
    );
    process.exitCode = 1;
  } else
    console.log(
      `ratchet-baselines: ${files.length} files do not widen ${base} (${newFiles} new)`,
    );
}

try {
  main();
} catch (error) {
  console.error(`ratchet-baselines: ${error.message}`);
  process.exitCode = 1;
}
