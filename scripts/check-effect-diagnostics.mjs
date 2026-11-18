#!/usr/bin/env node
// Runs the Effect language service over every source project and the test
// suites, and fails on any diagnostic it reports. The editor shows the same
// diagnostics, but nothing stopped a change that ignored them. Each rule's
// severity is the plugin's `diagnosticSeverity` in the project's tsconfig, so
// the editor and this check agree; one line is exempted with
// `// @effect-diagnostics-next-line <rule>:off` and a reason.

import { execFile } from 'node:child_process';
import console from 'node:console';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const rootDir = path.resolve(import.meta.dirname, '..');
// The root project covers the harness, the app and the extension; the suites
// project covers `src/test-kernel` and every package's `test/`.
const PROJECTS = [
  'tsconfig.json',
  'tsconfig.test-kernel.json',
  'packages/llm/tsconfig.json',
  'packages/cli/tsconfig.json',
  'packages/desktop/tsconfig.main.json',
  'packages/desktop/tsconfig.preload.json',
  'packages/desktop/tsconfig.renderer.json',
  'packages/trace-viewer/tsconfig.json',
];
const PROJECT_HEAP = ['--max-old-space-size=4096', process.env.NODE_OPTIONS]
  .filter(Boolean)
  .join(' ');
const run = promisify(execFile);
const bin = path.join(rootDir, 'node_modules/.bin/effect-language-service');

async function diagnose(project) {
  // The command exits non-zero when it reports an error, with the report
  // still on stdout.
  const { stdout } = await run(
    bin,
    [
      'diagnostics',
      '--project',
      path.join(rootDir, project),
      '--format',
      'json',
    ],
    {
      cwd: rootDir,
      maxBuffer: 256 * 1024 * 1024,
      // The suites project loads the sources and every suite: more than
      // Node's default heap on a 16 GB machine holds.
      env: { ...process.env, NODE_OPTIONS: PROJECT_HEAP },
    },
  ).catch((failure) => {
    if (typeof failure.stdout === 'string' && failure.stdout.includes('{'))
      return failure;
    throw failure;
  });
  const report = JSON.parse(stdout.slice(stdout.indexOf('{')));
  if (report.summary.filesChecked === 0)
    throw new Error(
      `${project}: the Effect language service checked no file; its tsconfig must list the plugin`,
    );
  return report.diagnostics;
}

// A project is one TypeScript program in memory: two at a time on a small
// machine, more where there are cores for it.
const lanes = Math.max(2, Math.floor(availableParallelism() / 2));
const queue = [...PROJECTS];
const found = new Map();
await Promise.all(
  Array.from({ length: lanes }, async () => {
    for (let project = queue.shift(); project; project = queue.shift())
      for (const d of await diagnose(project))
        found.set(`${d.file}:${d.start}:${d.name}`, d);
  }),
);

const diagnostics = [...found.values()].toSorted(
  (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
);
for (const d of diagnostics)
  console.error(
    `${path.relative(rootDir, d.file)}:${d.line}:${d.column} ${d.name}: ${d.message}`,
  );
if (diagnostics.length > 0) {
  console.error(
    `\n${diagnostics.length} Effect diagnostic(s). Fix each, or exempt one line with "// @effect-diagnostics-next-line <rule>:off" and the reason.`,
  );
  process.exitCode = 1;
} else console.log(`effect diagnostics: ${PROJECTS.length} projects clean`);
