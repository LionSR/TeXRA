#!/usr/bin/env node
// D8 test-LoC growth detector (issue #7684): reports the line-count delta
// of src/test-kernel/** against the checked-in baseline
// (config/ratchets/test-kernel-loc-baseline.json). Unlike
// check-dead-code-ratchet.mjs this
// is WARN-ONLY — it never fails CI — because the R7 judgment rules on
// test-kernel growth are qualitative (is a suite addition earning its
// LoC?), not a hard ratchet; this just surfaces the number so growth isn't
// invisible.

import { readdirSync, readFileSync } from 'node:fs';
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
  'test-kernel-loc-baseline.json',
);
const testKernelDir = path.join(rootDir, 'src', 'test-kernel');

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;

export function countLines(content) {
  if (content.length === 0) {
    return 0;
  }
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.length;
}

export function computeLocDelta(currentLoc, baselineLoc) {
  return {
    current: currentLoc,
    baseline: baselineLoc,
    delta: currentLoc - baselineLoc,
  };
}

// Split out from computeTestKernelLoc() so the walk can be exercised without
// touching the filesystem in tests, matching parseKnipIssues()'s split in
// check-dead-code-ratchet.mjs.
export function collectTestKernelFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((entry) => SOURCE_FILE.test(entry) && !entry.endsWith('.d.ts'))
    .map((entry) => path.join(dir, entry))
    .toSorted();
}

function computeTestKernelLoc(dir) {
  return collectTestKernelFiles(dir).reduce(
    (total, file) => total + countLines(readFileSync(file, 'utf8')),
    0,
  );
}

function main() {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const current = computeTestKernelLoc(testKernelDir);
  const { delta } = computeLocDelta(current, baseline.testKernelLoc);
  const direction = delta > 0 ? 'grew' : delta < 0 ? 'shrank' : 'is unchanged';

  console.log(
    `test-kernel LoC: ${current} (baseline ${baseline.testKernelLoc}, ${direction} by ${Math.abs(delta)} lines)`,
  );

  if (delta > 0) {
    console.log(
      'D8 warn-only report (issue #7684): test-kernel grew past its checked-in baseline. ' +
        'This does not fail CI. If the growth is a judged, earning-its-LoC addition, update ' +
        'config/ratchets/test-kernel-loc-baseline.json in this PR; otherwise no action is required.',
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
