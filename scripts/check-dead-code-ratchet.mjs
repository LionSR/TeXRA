#!/usr/bin/env node
// Ratchets knip's dead-code counts: fails CI only when a PR *increases* the
// number of unused files/exports/types or duplicate exports past the
// checked-in baseline (config/ratchets/knip-baseline.json), rather than blocking on the
// existing debt. Burning the baseline down is a separate, scheduled sweep.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const baselinePath = path.join(
  rootDir,
  'config',
  'ratchets',
  'knip-baseline.json',
);

const METRICS = /** @type {const} */ ([
  ['unusedFiles', 'files'],
  ['unusedExports', 'exports'],
  ['unusedTypes', 'types'],
  ['duplicateExports', 'duplicates'],
]);

export function summarizeKnipIssues(issues) {
  const counts = {
    unusedFiles: 0,
    unusedExports: 0,
    unusedTypes: 0,
    duplicateExports: 0,
  };
  for (const issue of issues) {
    for (const [countKey, issueKey] of METRICS) {
      counts[countKey] += (issue[issueKey] ?? []).length;
    }
  }
  return counts;
}

export function findRatchetViolations(current, baseline) {
  const violations = [];
  for (const [countKey] of METRICS) {
    const currentCount = current[countKey];
    const baselineCount = baseline[countKey];
    if (currentCount > baselineCount) {
      violations.push({ metric: countKey, currentCount, baselineCount });
    }
  }
  return violations;
}

// Parses and validates the `--reporter json` stdout produced by `knip`.
// Split out from runKnip() so the parsing/validation logic is unit-testable
// without spawning the real knip binary.
export function parseKnipIssues(stdout, stderr) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    console.error(stdout);
    console.error(stderr);
    throw new Error('knip did not produce parseable JSON output', { cause });
  }
  if (!Array.isArray(parsed?.issues)) {
    console.error(stdout);
    console.error(stderr);
    throw new Error(
      'knip JSON output has no `issues` array; the --reporter json shape may have changed (see scripts/check-dead-code-ratchet.mjs)',
    );
  }
  return parsed.issues;
}

function runKnip() {
  const knipBin = path.join(rootDir, 'node_modules', '.bin', 'knip');
  const result = spawnSync(
    knipBin,
    [
      '--no-progress',
      '--include',
      'files,exports,types,duplicates',
      '--reporter',
      'json',
    ],
    { cwd: rootDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) {
    throw result.error;
  }
  // knip exits 1 whenever it finds any issue at all, which is expected here
  // (the whole point is to count existing issues), so a non-zero status is
  // only a real failure if it didn't produce parseable JSON.
  return parseKnipIssues(result.stdout, result.stderr);
}

function main() {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const current = summarizeKnipIssues(runKnip());
  const violations = findRatchetViolations(current, baseline);

  console.log(
    `knip dead-code counts: unusedFiles=${current.unusedFiles} (baseline ${baseline.unusedFiles}), ` +
      `unusedExports=${current.unusedExports} (baseline ${baseline.unusedExports}), ` +
      `unusedTypes=${current.unusedTypes} (baseline ${baseline.unusedTypes}), ` +
      `duplicateExports=${current.duplicateExports} (baseline ${baseline.duplicateExports})`,
  );

  if (violations.length > 0) {
    console.error(
      '\nDead-code ratchet failed: this PR increases knip counts above the baseline.',
    );
    for (const { metric, currentCount, baselineCount } of violations) {
      console.error(
        `  - ${metric}: ${currentCount} > baseline ${baselineCount}`,
      );
    }
    console.error(
      '\nRun `npm run check:dead-code` to see the newly introduced dead code, then either ' +
        'remove it or, if the increase is intentional, update config/ratchets/knip-baseline.json in this PR.',
    );
    process.exit(1);
  }

  console.log('Dead-code ratchet OK: counts are at or below the baseline.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
