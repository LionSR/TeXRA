#!/usr/bin/env node
// The core-quality ratchet (owner, 2026-10-03: "super high coding quality like
// pi" for the harness and llm cores). core-quality-measure.mjs counts each
// rule's sites per core file; this gate holds those counts to
// config/ratchets/core-quality/<rule>.json, the public surface of the core
// packages to config/api-reports/, and their API references to
// packages/{harness,llm}/docs/api/.
//
// Counts are shrink-only. A file whose count rose, or a file absent from the
// baseline with a site, fails. A count that fell is stale headroom and fails
// too, because a later PR could regrow into it unnoticed; `--update` lowers
// counts and drops zeroed files but never raises one or adds a file. The one
// exception is file-size, whose value is a cap on a file's line count: a
// shorter file passes, and `--update` lowers a cap only to the file's length
// rounded up to a multiple of FILE_SIZE_STEP, and only when that is below the
// cap, so an edit that trims a few lines leaves file-size.json as it was.
// A rule listed in ZERO_RULES
// (ratchet-zero-rules.mjs) has no baseline file: any site fails.
// shallow-modules budgets interface elements while a module is shallow, so
// reducing its public surface lowers the row and deepening it removes it.
//
// The API reports are not budgets but review diffs: any change to an entry's
// exports fails until `--update` regenerates the report, so the diff of the
// public surface shows up in the PR that changes it. The API references
// regenerate the same way, so a TSDoc edit lands with its published page.
//
//   node scripts/check-core-quality.mjs            check
//   node scripts/check-core-quality.mjs --update   lower baselines, rewrite reports and references
//   node scripts/check-core-quality.mjs --report   per-package totals and hotspots
//   node scripts/check-core-quality.mjs --update --move packages/harness/src/agent/=packages/harness/src/
//     carry a moved file's or directory's rows to its new path (a rename is
//     not a new site); with --update only, and the counts still only shrink

import console from 'node:console';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { CORE_QUALITY_DIRS } from '../eslint.config.mjs';
import { GENERATED_DIRS, apiReports } from './core-quality-api-report.mjs';
import { MEASURED_ONLY, RULES, measure } from './core-quality-measure.mjs';
import { ZERO_RULES } from './ratchet-zero-rules.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const baselineDir = path.join(rootDir, 'config', 'ratchets', 'core-quality');
const SITES_SHOWN = 8;
/** The line step file-size caps are lowered in. */
const FILE_SIZE_STEP = 25;

const baselinePath = (rule) => path.join(baselineDir, `${rule}.json`);
const heldAtZero = (rule) =>
  Object.hasOwn(ZERO_RULES, `config/ratchets/core-quality/${rule}.json`);

/** The rule's baseline with each `from=to` path prefix re-keyed. */
function readBaseline(rule, moves) {
  const file = baselinePath(rule);
  if (!existsSync(file)) return null;
  const rekey = (key) => {
    const move = moves.find(([from]) => key.startsWith(from));
    return move == null ? key : `${move[1]}${key.slice(move[0].length)}`;
  };
  return Object.fromEntries(
    Object.entries(JSON.parse(readFileSync(file, 'utf8'))).map(
      ([key, value]) => [rekey(key), value],
    ),
  );
}

function writeJson(file, value) {
  const sorted = Object.fromEntries(
    Object.entries(value).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
}

function describeSites(entry) {
  const shown = entry.sites
    .slice(0, SITES_SHOWN)
    .map(({ line, detail }) => `      :${line} ${detail}`);
  const more = entry.sites.length - shown.length;
  return [...shown, ...(more > 0 ? [`      … ${more} more`] : [])].join('\n');
}

/** The baseline problems of one rule, as messages. */
function checkRule(rule, baseline, actual) {
  const problems = [];
  for (const [file, entry] of actual) {
    const allowed = baseline[file] ?? 0;
    if (entry.value > allowed) {
      problems.push(
        `${rule}: ${file} has ${entry.value}, baseline ${allowed} — ${RULES[rule]}\n${describeSites(entry)}`,
      );
    }
  }
  if (rule === 'file-size') return problems;
  for (const [file, allowed] of Object.entries(baseline)) {
    const value = actual.get(file)?.value ?? 0;
    if (value < allowed) {
      problems.push(
        `${rule}: ${file} has ${value}, baseline ${allowed}: stale headroom — run \`node scripts/check-core-quality.mjs --update\` in the same change`,
      );
    }
  }
  return problems;
}

/** The lowered baseline of one rule, and every file it would widen. */
function lowered(rule, baseline, actual) {
  const next = {};
  const widened = [];
  for (const [file, entry] of actual) {
    const allowed = baseline[file] ?? 0;
    if (entry.value > allowed)
      widened.push(
        `${rule}: ${file} has ${entry.value}, above its baseline ${allowed}; --update never widens a baseline. ${RULES[rule]}`,
      );
    next[file] =
      rule === 'file-size'
        ? Math.min(
            allowed,
            Math.ceil(entry.value / FILE_SIZE_STEP) * FILE_SIZE_STEP,
          )
        : entry.value;
  }
  return { next, widened };
}

function checkReports(reports, update) {
  const problems = [];
  const existing = new Set(
    GENERATED_DIRS.flatMap((dir) => {
      mkdirSync(path.join(rootDir, dir), { recursive: true });
      return readdirSync(path.join(rootDir, dir))
        .filter((name) => name.endsWith('.md'))
        .map((name) => `${dir}/${name}`);
    }),
  );
  for (const [name, text] of reports) {
    existing.delete(name);
    const file = path.join(rootDir, name);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current === text) continue;
    if (update) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    } else
      problems.push(
        `api-report: ${name} ${current == null ? 'is missing' : 'differs from the package exports'} — run \`node scripts/check-core-quality.mjs --update\` and review the diff`,
      );
  }
  for (const name of existing) {
    problems.push(`api-report: ${name} has no package entry — delete it`);
  }
  return problems;
}

/** Rules keyed by something other than a core source file. */
const NOT_PER_FILE = new Set([
  'missing-readme',
  'entry-files',
  'entry-externals',
  'core-module-mocks',
  'ranged-dependencies',
  'durable-invariants',
]);

function printReport(files, byRule, moduleDepths) {
  const packageOf = (file) =>
    CORE_QUALITY_DIRS.find((dir) => file === dir || file.startsWith(`${dir}/`));
  const lineCount = (file) =>
    readFileSync(path.join(rootDir, file), 'utf8').split('\n').length;
  const header = [
    'package',
    'files',
    'lines',
    ...Object.keys(RULES).filter((rule) => !NOT_PER_FILE.has(rule)),
  ];
  console.log(header.join('\t'));
  for (const dir of CORE_QUALITY_DIRS) {
    const own = files.filter((file) => packageOf(file) === dir);
    const counts = header
      .slice(3)
      .map((rule) =>
        [...byRule.get(rule)].reduce(
          (sum, [file, entry]) =>
            packageOf(file) === dir
              ? sum + (rule === 'file-size' ? 1 : entry.value)
              : sum,
          0,
        ),
      );
    const lines = own.reduce((sum, file) => sum + lineCount(file), 0);
    console.log([dir, own.length, lines, ...counts].join('\t'));
  }
  const HOTSPOT_RULES = [
    'file-size',
    'complexity',
    'max-depth',
    'max-lines-per-function',
    'type-assertions',
    'no-non-null-assertion',
    'wide-records',
    'pass-through',
    'shallow-modules',
  ];
  const score = new Map();
  for (const rule of HOTSPOT_RULES) {
    for (const [file, entry] of byRule.get(rule)) {
      const weight =
        rule === 'file-size' ? Math.floor(entry.value / 100) : entry.value;
      score.set(file, (score.get(file) ?? 0) + weight);
    }
  }
  console.log(
    `\nhotspots (file-size in hundreds of lines + sites of ${HOTSPOT_RULES.slice(1).join(', ')}):`,
  );
  for (const [file, value] of [...score]
    .toSorted((left, right) => right[1] - left[1])
    .slice(0, 25)) {
    const parts = HOTSPOT_RULES.filter((rule) =>
      byRule.get(rule).has(file),
    ).map((rule) => `${rule}=${byRule.get(rule).get(file).value}`);
    console.log(`${value}\t${file}\t${parts.join(' ')}`);
  }
  console.log(
    '\nshallowest eligible modules (non-comment lines / interface elements):',
  );
  for (const { file, lines, elements, ratio } of moduleDepths
    .toSorted(
      (left, right) =>
        left.ratio - right.ratio || left.file.localeCompare(right.file),
    )
    .slice(0, 15)) {
    console.log(
      `${file}\t${lines} / ${elements} = ${ratio.toFixed(2)}\t${byRule.get('shallow-modules').has(file) ? 'shallow' : 'within threshold'}`,
    );
  }
  console.log(
    '\npass-through hotspots (functions plus forwarding-only modules):',
  );
  for (const [file, entry] of [...byRule.get('pass-through')]
    .toSorted(
      (left, right) =>
        right[1].value - left[1].value || left[0].localeCompare(right[0]),
    )
    .slice(0, 15)) {
    console.log(`${entry.value}\t${file}\n${describeSites(entry)}`);
  }
  console.log('\nper key (rules not keyed by a core source file):');
  for (const rule of [
    'entry-files',
    'entry-externals',
    'wide-records',
    'core-module-mocks',
    'non-erasable-syntax',
    'ranged-dependencies',
    'durable-invariants',
    'decision-codes',
  ]) {
    const entries = [...byRule.get(rule)];
    const total = entries.reduce((sum, [, entry]) => sum + entry.value, 0);
    console.log(`${rule}: total ${total} over ${entries.length} keys`);
    if (
      rule.startsWith('entry-') ||
      rule === 'ranged-dependencies' ||
      rule === 'wide-records'
    ) {
      for (const [key, entry] of entries) {
        console.log(`  ${key}\t${entry.value}\t${entry.sites.at(-1).detail}`);
      }
    }
  }
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      update: { type: 'boolean', default: false },
      report: { type: 'boolean', default: false },
      move: { type: 'string', multiple: true, default: [] },
    },
  });
  const moves = values.move.map((spec) => spec.split('='));
  if (moves.length > 0 && !values.update) {
    throw new Error('--move re-keys the baselines, so it needs --update');
  }
  const { files, byRule, moduleDepths } = await measure(rootDir);
  if (values.report) {
    printReport(files, byRule, moduleDepths);
    return;
  }
  const problems = [];
  mkdirSync(baselineDir, { recursive: true });
  // An update writes nothing until every rule is checked: one rule it
  // would widen leaves every baseline as it was, and all are reported.
  const writes = [];
  for (const [rule, actual] of byRule) {
    if (MEASURED_ONLY.has(rule)) continue;
    if (heldAtZero(rule)) {
      problems.push(...checkRule(rule, {}, actual));
      continue;
    }
    const baseline = readBaseline(rule, moves);
    if (values.update) {
      // A rule without a baseline file is new: its first baseline is today's count.
      const { next, widened } =
        baseline == null
          ? {
              next: Object.fromEntries(
                [...actual].map(([file, entry]) => [file, entry.value]),
              ),
              widened: [],
            }
          : lowered(rule, baseline, actual);
      problems.push(...widened);
      writes.push([baselinePath(rule), next]);
    } else if (baseline == null) {
      problems.push(
        `${rule}: config/ratchets/core-quality/${rule}.json is missing`,
      );
    } else {
      problems.push(...checkRule(rule, baseline, actual));
    }
  }
  if (problems.length === 0)
    for (const [file, next] of writes) writeJson(file, next);
  problems.push(
    ...checkReports(
      apiReports(rootDir),
      values.update && problems.length === 0,
    ),
  );
  if (problems.length > 0) {
    console.error(
      `core-quality: ${problems.length} problem(s)\n\n${problems.join('\n\n')}`,
    );
    process.exitCode = 1;
  } else if (!values.update) {
    console.log(
      `core-quality: ${files.length} core files hold their baselines`,
    );
  }
};

await main();
