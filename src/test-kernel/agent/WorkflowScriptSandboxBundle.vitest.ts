import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '@test/support/repoScan';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const execFileAsync = promisify(execFile);
const sandboxPath = path.join(REPO_ROOT, 'src/agent/workflowScript/sandbox.ts');
const temporaryDirectories = useTempDirs();

describe('workflow sandbox host bundles', () => {
  it.each([
    { host: 'extension', format: 'cjs', extension: 'cjs' },
    { host: 'CLI and desktop', format: 'esm', extension: 'mjs' },
  ] as const)(
    'instantiates embedded QuickJS from the $host bundle shape',
    async ({ format, extension }) => {
      const directory = await makeTempDir(
        'texra-workflow-sandbox-',
        temporaryDirectories,
      );
      const outfile = path.join(directory, `smoke.${extension}`);

      await build({
        stdin: {
          contents: smokeEntrySource(),
          loader: 'ts',
          resolveDir: REPO_ROOT,
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
        tsconfig: path.join(REPO_ROOT, 'tsconfig.json'),
      });

      const run = await execFileAsync(process.execPath, [outfile], {
        timeout: 5_000,
      });
      expect(run.stdout.trim()).toBe('42');
    },
  );
});

function smokeEntrySource(): string {
  return `
import { Effect } from 'effect';
import { openWorkflowRealm } from ${JSON.stringify(sandboxPath)};

async function main() {
  const reply = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const realm = yield* openWorkflowRealm(
      'return 42',
      {
        syncFns: {},
        argsJson: undefined,
        filesJson: '{"inputFiles":[],"contextFiles":[],"mediaFiles":[]}',
      },
      { filename: 'bundle-smoke.workflow.js', shouldInterrupt: () => false },
    );
    const generator = yield* realm.start(realm.main);
    return yield* realm.resume(generator, { kind: 'next', value: undefined });
  })));
  const result = reply.kind === 'done' ? reply.value : reply;
  console.log(result);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
}
