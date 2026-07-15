import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const sandboxPath = path.join(
  repositoryRoot,
  'src/agent/workflowScript/sandbox.ts',
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('workflow sandbox host bundles', () => {
  it.each([
    { host: 'extension', format: 'cjs', extension: 'cjs' },
    { host: 'CLI and desktop', format: 'esm', extension: 'mjs' },
  ] as const)(
    'instantiates embedded QuickJS from the $host bundle shape',
    async ({ format, extension }) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'texra-workflow-sandbox-'),
      );
      temporaryDirectories.push(directory);
      const outfile = path.join(directory, `smoke.${extension}`);

      await build({
        stdin: {
          contents: smokeEntrySource(),
          loader: 'ts',
          resolveDir: repositoryRoot,
          sourcefile: 'workflow-sandbox-smoke.ts',
        },
        bundle: true,
        ...(format === 'cjs'
          ? {
              banner: {
                js: 'var importMetaUrl = require("node:url").pathToFileURL(__filename).href;',
              },
              define: { 'import.meta.url': 'importMetaUrl' },
            }
          : {}),
        format,
        loader: { '.wasm': 'binary' },
        outfile,
        platform: 'node',
        target: 'node22',
        tsconfig: path.join(repositoryRoot, 'tsconfig.json'),
      });

      const execution = await execFileAsync(process.execPath, [outfile], {
        timeout: 5_000,
      });
      expect(execution.stdout.trim()).toBe('42');
    },
  );
});

function smokeEntrySource(): string {
  return `
import { runScriptInSandbox } from ${JSON.stringify(sandboxPath)};

async function main() {
  const result = await runScriptInSandbox(
    'return 42',
    { asyncFns: {}, syncFns: {}, argsJson: undefined },
    { filename: 'bundle-smoke.workflow.js', timeoutMs: 1_000 },
  );
  console.log(result);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
}
