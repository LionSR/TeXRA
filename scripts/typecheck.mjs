// `npm run typecheck`: every type check the repository runs, started at once.
//
// Each check is its own program over its own tsconfig, and none reads what
// another writes: the configs that extend the root one reach the harness and
// llm through their sources (the root `paths`, the llm package's workspace
// `exports`), not through the `dist/` the harness and llm builds here write.
// Run one after another they took the sum of their times; run together they
// take the longest, with the rest filling the cores it leaves idle. Each
// check's output is held until it ends, so a failure reads as one block
// under its name rather than interleaved with the others'.
import { spawn } from 'node:child_process';
import console from 'node:console';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
// The `tsc` bin's JavaScript entry, not its shell shim, so Windows needs no
// shell either; the package exports no `bin/` path, so it is reached from
// its package.json.
const tsc = join(
  dirname(
    createRequire(import.meta.url).resolve('@typescript/native/package.json'),
  ),
  'bin',
  'tsc',
);
const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';

/** @type {{ name: string; command: readonly string[] }[]} */
const CHECKS = [
  {
    name: 'root',
    command: [process.execPath, tsc, '--noEmit', '--checkers', '8'],
  },
  {
    name: 'test-kernel',
    command: [
      process.execPath,
      tsc,
      '--noEmit',
      '--checkers',
      '8',
      '-p',
      'tsconfig.test-kernel.json',
    ],
  },
  // The harness's check is its full build, which regenerates its dist/.
  {
    name: 'harness',
    command: [corepack, 'pnpm', '--filter', '@texra-ai/harness', 'build'],
  },
  {
    name: 'llm',
    command: [corepack, 'pnpm', '--filter', '@texra-ai/llm', 'typecheck'],
  },
  {
    name: 'cli',
    command: [corepack, 'pnpm', '--filter', '@texra-ai/cli', 'typecheck'],
  },
  {
    name: 'trace-viewer',
    command: [
      corepack,
      'pnpm',
      '--filter',
      '@texra/trace-viewer',
      'run',
      'typecheck',
    ],
  },
  {
    name: 'desktop',
    command: [corepack, 'pnpm', '--filter', '@texra/desktop', 'typecheck'],
  },
];

/** Run one check to its end; resolves to its exit status and output. */
const run = ({ name, command }) =>
  new Promise((resolve) => {
    const started = performance.now();
    const chunks = [];
    const child = spawn(command[0], command.slice(1), {
      cwd: rootDir,
      // Windows resolves `corepack.cmd` through the shell only.
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => {
      chunks.push(Buffer.from(`${error.message}\n`));
      resolve({ name, status: 1, output: Buffer.concat(chunks), started });
    });
    child.on('close', (status) =>
      resolve({
        name,
        status: status ?? 1,
        output: Buffer.concat(chunks),
        started,
      }),
    );
  });

const results = await Promise.all(
  CHECKS.map((check) =>
    run(check).then((result) => {
      const seconds = ((performance.now() - result.started) / 1000).toFixed(1);
      const verdict =
        result.status === 0 ? 'ok' : `failed (exit ${result.status})`;
      console.log(`typecheck: ${result.name} ${verdict} in ${seconds}s`);
      if (result.status !== 0 && result.output.length > 0)
        process.stdout.write(result.output);
      return result;
    }),
  ),
);

const failed = results.filter((result) => result.status !== 0);
if (failed.length > 0) {
  console.error(
    `typecheck: ${failed.map((result) => result.name).join(', ')} failed.`,
  );
  process.exit(1);
}
