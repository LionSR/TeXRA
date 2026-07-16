#!/usr/bin/env node
// Ratchets knip's dead-code findings: fails CI when a PR introduces a newly
// unused file/export/type/duplicate-export group that isn't already recorded
// in the checked-in baseline (config/ratchets/knip-baseline.json), rather
// than blocking on the existing debt. Burning the baseline down is a
// separate, scheduled sweep.
//
// Each finding is identified by (file, category, name) -- deliberately never
// by line number, so an unrelated edit that shifts lines above a dead export
// does not spuriously "resolve" it in the baseline. This mirrors the
// by-identity ratchet pattern used elsewhere (see
// src/test-kernel/architecture/subsystemEdgeRatchet.vitest.ts) rather than
// this script's previous count-based threshold, which let any new unused
// export land silently as long as some other unused export was deleted in
// the same PR.

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

const EMPTY_COUNTS = { files: 0, exports: 0, types: 0, duplicates: 0 };

// Flattens knip's per-issue-file shape (`{ file, files, exports, types,
// duplicates }`) into one finding per unused symbol, keyed by (file,
// category, name). A `duplicates` entry is a group of co-exported names that
// alias the same declaration; the group's own identity is the sorted,
// comma-joined member names, since knip doesn't give the group itself a name.
export function extractFindings(issues) {
  const findings = [];
  for (const issue of issues) {
    for (const entry of issue.files ?? []) {
      findings.push({ file: issue.file, category: 'files', name: entry.name });
    }
    for (const entry of issue.exports ?? []) {
      findings.push({
        file: issue.file,
        category: 'exports',
        name: entry.name,
      });
    }
    for (const entry of issue.types ?? []) {
      findings.push({ file: issue.file, category: 'types', name: entry.name });
    }
    for (const group of issue.duplicates ?? []) {
      const name = group
        .map((entry) => entry.name)
        .sort()
        .join(',');
      findings.push({ file: issue.file, category: 'duplicates', name });
    }
  }
  return findings;
}

export function findingKey(finding) {
  return `${finding.file} ${finding.category} ${finding.name}`;
}

export function compareFindings(a, b) {
  return (
    a.file.localeCompare(b.file) ||
    a.category.localeCompare(b.category) ||
    a.name.localeCompare(b.name)
  );
}

// Diffs by identity, not by count: a finding is "new" only if no baseline
// entry shares its (file, category, name), and a baseline entry is
// "resolved" only if nothing in the current run matches it. Both lists come
// back sorted for stable, readable CLI output.
export function diffFindings(current, baseline) {
  const baselineKeys = new Set(baseline.map(findingKey));
  const currentKeys = new Set(current.map(findingKey));
  return {
    newFindings: current
      .filter((finding) => !baselineKeys.has(findingKey(finding)))
      .toSorted(compareFindings),
    resolvedFindings: baseline
      .filter((finding) => !currentKeys.has(findingKey(finding)))
      .toSorted(compareFindings),
  };
}

export function countByCategory(findings) {
  const counts = { ...EMPTY_COUNTS };
  for (const { category } of findings) {
    counts[category] += 1;
  }
  return counts;
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
  // (the whole point is to enumerate existing issues), so a non-zero status
  // is only a real failure if it didn't produce parseable JSON.
  return parseKnipIssues(result.stdout, result.stderr);
}

export function readBaseline(rawJson) {
  const data = JSON.parse(rawJson);
  if (!Array.isArray(data.findings)) {
    throw new Error(
      `${baselinePath} is missing a "findings" array; regenerate it (see scripts/check-dead-code-ratchet.mjs)`,
    );
  }
  return data.findings;
}

function formatFinding(finding) {
  return `[${finding.category}] ${finding.file}: ${finding.name}`;
}

function main() {
  const baseline = readBaseline(readFileSync(baselinePath, 'utf8'));
  const current = extractFindings(runKnip());
  const { newFindings, resolvedFindings } = diffFindings(current, baseline);
  const counts = countByCategory(current);

  console.log(
    `knip dead-code findings: ${current.length} current (unusedFiles=${counts.files}, ` +
      `unusedExports=${counts.exports}, unusedTypes=${counts.types}, ` +
      `duplicateExports=${counts.duplicates}) vs ${baseline.length} baselined`,
  );

  if (newFindings.length > 0) {
    console.error(
      `\nDead-code ratchet failed: this PR introduces ${newFindings.length} unused file(s)/export(s)/type(s) not in the baseline.`,
    );
    for (const finding of newFindings) {
      console.error(`  - ${formatFinding(finding)}`);
    }
    console.error(
      '\nRun `npm run check:dead-code` to see the newly introduced dead code, then either ' +
        'remove it or, if the addition is intentional, add it to config/ratchets/knip-baseline.json in this PR ' +
        '(keep the "findings" array sorted by file, then category, then name).',
    );
    process.exit(1);
  }

  console.log('Dead-code ratchet OK: no new unused files/exports/types found.');
  if (resolvedFindings.length > 0) {
    console.log(
      `\n${resolvedFindings.length} baseline entries are no longer found (fixed!). Remove them from ` +
        'config/ratchets/knip-baseline.json to shrink the baseline:',
    );
    for (const finding of resolvedFindings) {
      console.log(`  - ${formatFinding(finding)}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
