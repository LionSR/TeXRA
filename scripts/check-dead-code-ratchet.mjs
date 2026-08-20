#!/usr/bin/env node
// Ratchets Knip's normal and production dead-code findings against one
// checked-in baseline (config/ratchets/knip-baseline.json), rather than
// blocking on the existing debt. Burning the baseline down is a separate,
// scheduled sweep.
//
// Each finding is identified by (file, category, kind, name), deliberately
// never by line number. `category` records whether the normal run found it as
// unused or only the production run found it as production-dead; `kind`
// preserves Knip's files/exports/types/duplicates classification.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
  classifyFindings,
  compareFindings,
  countByCategory,
  diffFindings,
  extractFindings,
  findingKey,
  parseKnipIssues,
  readBaseline,
} from './check-dead-code-ratchet-core.mjs';
import {
  classifyFindings,
  countByCategory,
  diffFindings,
  extractFindings,
  parseKnipIssues,
  readBaseline,
} from './check-dead-code-ratchet-core.mjs';

function runKnip({ production = false } = {}) {
  const knipBin = path.join(rootDir, 'node_modules', '.bin', 'knip');
  const args = [
    '--no-progress',
    '--include',
    'files,exports,types,duplicates',
    '--reporter',
    'json',
  ];
  if (production) {
    args.push('--production');
  }
  const result = spawnSync(knipBin, args, {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  // Knip exits 1 whenever it finds any issue at all, which is expected here.
  // A non-zero status is only a real failure if it did not produce JSON.
  return parseKnipIssues(result.stdout, result.stderr);
}

function findStrayBuildArtifacts(findings) {
  const artifacts = new Map();
  for (const finding of findings) {
    if (finding.category !== 'files' || !/\.tsx?$/.test(finding.file)) {
      continue;
    }
    const artifact = finding.file.replace(/\.tsx?$/, '.js');
    if (existsSync(path.join(rootDir, artifact))) {
      artifacts.set(artifact, { artifact, source: finding.file });
    }
  }
  return [...artifacts.values()];
}

function formatFinding(finding) {
  return `[${finding.category}/${finding.kind}] ${finding.file}: ${finding.name}`;
}

function main() {
  const baseline = readBaseline(
    readFileSync(baselinePath, 'utf8'),
    baselinePath,
  );
  const normalFindings = extractFindings(runKnip());
  const productionFindings = extractFindings(runKnip({ production: true }));
  const strayArtifacts = findStrayBuildArtifacts([
    ...normalFindings,
    ...productionFindings,
  ]);

  if (strayArtifacts.length > 0) {
    console.error(
      '\nDead-code ratchet failed: stray build artifact(s) shadow TypeScript source:',
    );
    for (const { artifact, source } of strayArtifacts) {
      console.error(
        `  - ${artifact} shadows ${source}; delete ${artifact} and re-run`,
      );
    }
    process.exit(1);
  }

  const current = classifyFindings(normalFindings, productionFindings);
  const { newFindings, resolvedFindings } = diffFindings(current, baseline);
  const counts = countByCategory(current);

  console.log(
    `knip dead-code findings: ${normalFindings.length} normal, ${productionFindings.length} production; ` +
      `${current.length} combined (unused=${counts.unused ?? 0}, ` +
      `productionDead=${counts['production-dead'] ?? 0}) vs ${baseline.length} baselined`,
  );

  if (newFindings.length > 0) {
    console.error(
      `\nDead-code ratchet failed: this PR introduces ${newFindings.length} finding(s) not in the baseline.`,
    );
    for (const finding of newFindings) {
      console.error(`  - ${formatFinding(finding)}`);
    }
    console.error(
      '\nRun `npm run check:dead-code-ratchet` as the authoritative dead-code check, then either ' +
        'remove the finding or, if the addition is intentional, add it to config/ratchets/knip-baseline.json in this PR ' +
        '(keep the "findings" array sorted by file, category, kind, then name).',
    );
    process.exit(1);
  }

  console.log('Dead-code ratchet OK: no new findings.');
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
