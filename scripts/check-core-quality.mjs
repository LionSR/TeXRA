#!/usr/bin/env node
// The core-quality ratchet (owner, 2026-10-03: "super high coding quality like
// pi" for the harness and llm cores). core-quality-measure.mjs counts each
// rule's sites per core file; this gate holds those counts to
// config/ratchets/core-quality/<rule>.json and the public surface of the core
// packages to config/api-reports/.
//
// Counts are shrink-only. A file whose count rose, or a file absent from the
// baseline with a site, fails. A count that fell is stale headroom and fails
// too, because a later PR could regrow into it unnoticed; `--update` lowers
// counts and drops zeroed files but never raises one or adds a file. The one
// exception is file-size, whose value is a line count: a shorter file passes,
// and `--update` lowers its cap. A rule with an empty baseline holds the core
// at zero.
//
// The API reports are not budgets but review diffs: any change to an entry's
// exports fails until `--update` regenerates the report, so the diff of the
// public surface shows up in the PR that changes it.
//
//   node scripts/check-core-quality.mjs            check
//   node scripts/check-core-quality.mjs --update   lower baselines, rewrite reports
//   node scripts/check-core-quality.mjs --report   per-package totals and hotspots
//   node scripts/check-core-quality.mjs --update --move src/agent/=packages/harness/src/
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
import { apiReports } from './core-quality-api-report.mjs';
import { RULES, measure } from './core-quality-measure.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const baselineDir = path.join(rootDir, 'config', 'ratchets', 'core-quality');
const reportDir = path.join(rootDir, 'config', 'api-reports');
const SITES_SHOWN = 8;

const baselinePath = (rule) => path.join(baselineDir, `${rule}.json`);

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

/** The lowered baseline of one rule; throws rather than widen. */
function lowered(rule, baseline, actual) {
  const next = {};
  for (const [file, entry] of actual) {
    const allowed = baseline[file] ?? 0;
    if (entry.value > allowed) {
      throw new Error(
        `${rule}: ${file} has ${entry.value}, above its baseline ${allowed}; --update never widens a baseline. ${RULES[rule]}`,
      );
    }
    next[file] = entry.value;
  }
  return next;
}

function checkReports(reports, update) {
  const problems = [];
  mkdirSync(reportDir, { recursive: true });
  const existing = new Set(
    readdirSync(reportDir).filter((name) => name.endsWith('.api.md')),
  );
  for (const [name, text] of reports) {
    existing.delete(name);
    const file = path.join(reportDir, name);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current === text) continue;
    if (update) writeFileSync(file, text);
    else
      problems.push(
        `api-report: config/api-reports/${name} ${current == null ? 'is missing' : 'differs from the package exports'} — run \`node scripts/check-core-quality.mjs --update\` and review the surface diff`,
      );
  }
  for (const name of existing) {
    problems.push(
      `api-report: config/api-reports/${name} has no package entry — delete it`,
    );
  }
  return problems;
}

function printReport(files, byRule) {
  const packageOf = (file) =>
    CORE_QUALITY_DIRS.find((dir) => file.startsWith(`${dir}/`));
  const lineCount = (file) =>
    readFileSync(path.join(rootDir, file), 'utf8').split('\n').length;
  const header = [
    'package',
    'files',
    'lines',
    ...Object.keys(RULES).filter((rule) => rule !== 'missing-readme'),
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
  const score = new Map();
  for (const [rule, entries] of byRule) {
    if (rule === 'missing-readme' || rule === 'undocumented-exports') continue;
    for (const [file, entry] of entries) {
      const weight =
        rule === 'file-size' ? Math.floor(entry.value / 100) : entry.value;
      score.set(file, (score.get(file) ?? 0) + weight);
    }
  }
  console.log(
    '\nhotspots (file-size in hundreds of lines + complexity/depth/params/long-function/cast/! sites):',
  );
  for (const [file, value] of [...score]
    .toSorted((left, right) => right[1] - left[1])
    .slice(0, 25)) {
    const parts = [...byRule]
      .filter(
        ([rule, entries]) =>
          rule !== 'undocumented-exports' && entries.has(file),
      )
      .map(([rule, entries]) => `${rule}=${entries.get(file).value}`);
    console.log(`${value}\t${file}\t${parts.join(' ')}`);
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
  const { files, byRule } = await measure(rootDir);
  if (values.report) {
    printReport(files, byRule);
    return;
  }
  const problems = [];
  mkdirSync(baselineDir, { recursive: true });
  for (const [rule, actual] of byRule) {
    const baseline = readBaseline(rule, moves);
    if (values.update) {
      // A rule without a baseline file is new: its first baseline is today's count.
      writeJson(
        baselinePath(rule),
        baseline == null
          ? Object.fromEntries(
              [...actual].map(([file, entry]) => [file, entry.value]),
            )
          : lowered(rule, baseline, actual),
      );
    } else if (baseline == null) {
      problems.push(
        `${rule}: config/ratchets/core-quality/${rule}.json is missing`,
      );
    } else {
      problems.push(...checkRule(rule, baseline, actual));
    }
  }
  problems.push(...checkReports(apiReports(rootDir), values.update));
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
