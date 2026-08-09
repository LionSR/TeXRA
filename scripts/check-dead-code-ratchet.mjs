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

export {
  compareFindings,
  countByCategory,
  diffFindings,
  extractFindings,
  findingKey,
  parseKnipIssues,
  readBaseline,
} from './check-dead-code-ratchet-core.mjs';
import {
  countByCategory,
  diffFindings,
  extractFindings,
  parseKnipIssues,
  readBaseline,
} from './check-dead-code-ratchet-core.mjs';

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

function formatFinding(finding) {
  return `[${finding.category}] ${finding.file}: ${finding.name}`;
}

function main() {
  const baseline = readBaseline(
    readFileSync(baselinePath, 'utf8'),
    baselinePath,
  );
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
