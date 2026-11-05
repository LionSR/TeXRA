#!/usr/bin/env node
// The core-quality ratchet (owner, 2026-10-03: "super high coding quality like
// pi" for the harness and llm cores). core-quality-measure.mjs counts each
// rule's sites per core file; this gate holds those counts to the merge base
// with origin/main (ratchet-base.mjs: `--base <ref>` or TEXRA_RATCHET_BASE,
// the pull request's target in CI). The same analyzer runs over the base's
// tree, extracted with `git archive`, so a file whose count rose fails and
// names its sites, a file new on the head starts at zero, a renamed file
// keeps its count once the rename is staged, and a count that fell needs no
// edit: nothing is committed and nothing regenerated. A rule in ZERO_RULES
// fails any site. file-size is a cap: a file may not grow past its base
// length rounded up to a multiple of FILE_SIZE_STEP, which never rises, so
// small edits inside the step are free.
// shallow-modules budgets interface elements while a module is shallow, so
// reducing its public surface lowers the row and deepening it removes it.
//
// The public surface of the core packages is held to config/api-reports/ and
// their API references to packages/{harness,llm}/docs/api/. Those are not
// budgets but review diffs: any change to an entry's exports fails until
// `--docgen` regenerates the report, so the diff of the public surface shows
// up in the PR that changes it. The API references regenerate the same way,
// so a TSDoc edit lands with its published page.
//
//   node scripts/check-core-quality.mjs               check against the merge base
//   node scripts/check-core-quality.mjs --base <ref>  check against the merge base with <ref>
//   node scripts/check-core-quality.mjs --docgen      rewrite the API reports and references
//   node scripts/check-core-quality.mjs --report      per-package totals and hotspots

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

import { GENERATED_DIRS, apiReports } from './core-quality-api-report.mjs';
import {
  CORE_FILE_LINES,
  CORE_QUALITY_DIRS,
  RULES,
  measure,
} from './core-quality-measure.mjs';
import { ratchetBase, renamesSince, withBaseTree } from './ratchet-base.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const SITES_SHOWN = 8;
/** The line step a file-size cap is rounded up in. */
const FILE_SIZE_STEP = 25;

/** Rules no file may break any more: any site fails, whatever the base holds. */
const ZERO_RULES = new Set([
  'consistent-type-assertions',
  'durable-invariants',
  'effect-run',
  'import-cycles',
  'lint-disable',
  'new-promise',
  'no-explicit-any',
  'no-non-null-assertion',
  'no-non-null-assertion-test-kernel',
  'promise-then',
  'try-catch-effect',
  'type-assertions',
  'type-assertions-outside-core',
  'type-assertions-test-kernel',
]);

function describeSites(entry) {
  const shown = entry.sites
    .slice(0, SITES_SHOWN)
    .map(({ line, detail }) => `      :${line} ${detail}`);
  const more = entry.sites.length - shown.length;
  return [...shown, ...(more > 0 ? [`      … ${more} more`] : [])].join('\n');
}

/**
 * The keys whose count rose above the base's, as messages. `base` is the
 * rule's base measurement, or null for a rule held at zero; `baseKey` maps a
 * head key to the base's (a renamed file keeps its row). A key the base
 * measurement lacks had no site there (for file-size, at most
 * CORE_FILE_LINES lines); a file new on the head, or moved without its
 * rename staged, reads the same way.
 */
function checkRule(rule, base, actual, baseKey) {
  const problems = [];
  for (const [key, entry] of actual) {
    const before = base?.get(baseKey(key))?.value;
    const baseValue = before ?? (rule === 'file-size' ? CORE_FILE_LINES : 0);
    const allowed =
      rule === 'file-size'
        ? Math.ceil(baseValue / FILE_SIZE_STEP) * FILE_SIZE_STEP
        : baseValue;
    if (entry.value <= allowed) continue;
    const absent =
      rule === 'file-size'
        ? `merge base at most ${CORE_FILE_LINES} lines (within the threshold there)`
        : 'merge base 0 (no site there)';
    const bound =
      base == null
        ? 'held at zero'
        : before == null
          ? `${absent}: a new file, or a move whose rename is not staged`
          : `merge base ${allowed}${allowed === before ? '' : ` (${before} lines rounded up to ${FILE_SIZE_STEP})`}`;
    problems.push(
      `${rule}: ${key} has ${entry.value}, ${bound} — ${RULES[rule]}\n${describeSites(entry)}`,
    );
  }
  return problems;
}

function checkReports(reports, write) {
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
    if (write) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    } else
      problems.push(
        `api-report: ${name} ${current == null ? 'is missing' : 'differs from the package exports'} — run \`npm run docgen\` and review the diff`,
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

function printReport({ files, byRule, moduleDepths }) {
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

function conclude(problems, passed) {
  if (problems.length > 0) {
    console.error(
      `core-quality: ${problems.length} problem(s)\n\n${problems.join('\n\n')}`,
    );
    process.exitCode = 1;
  } else console.log(passed);
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      docgen: { type: 'boolean', default: false },
      report: { type: 'boolean', default: false },
    },
  });
  if (values.docgen) {
    conclude(
      checkReports(apiReports(rootDir), true),
      'core-quality: API reports and references rewritten',
    );
    return;
  }
  if (values.report) {
    printReport(await measure(rootDir));
    return;
  }
  const { target, base } = ratchetBase(values.base);
  const { files, byRule } = await measure(rootDir);
  const before = await withBaseTree(
    base,
    async (tree) => (await measure(tree)).byRule,
  );
  const renamed = new Map(renamesSince(base).map(([from, to]) => [to, from]));
  const baseKey = (key) => renamed.get(key) ?? key;
  const problems = [];
  for (const [rule, actual] of byRule) {
    problems.push(
      ...checkRule(
        rule,
        ZERO_RULES.has(rule) ? null : before.get(rule),
        actual,
        baseKey,
      ),
    );
  }
  problems.push(...checkReports(apiReports(rootDir), false));
  conclude(
    problems,
    `core-quality: ${files.length} core files hold their counts against ${target} (fork point ${base.slice(0, 10)})`,
  );
};

try {
  await main();
} catch (error) {
  // The message carries git's own output, so the cause adds only a stack.
  console.error(`core-quality: ${error.message}`);
  process.exitCode = 1;
}
