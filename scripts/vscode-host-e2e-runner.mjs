// Runs the built extension inside a real VS Code and checks it from the
// extension host (`vscode-host-e2e-suite.cjs`). Build first
// (`npm run compile:fast`); then:
//
//   node scripts/vscode-host-e2e-runner.mjs [--vscode stable|minimum|<x.y.z>]
//
// `minimum` is `engines.vscode` from the extension manifest, so the run also
// catches use of a VS Code API newer than the manifest claims.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const extensionPath = path.join(repoRoot, 'packages/extension');

const flag = process.argv.indexOf('--vscode');
const requested = flag === -1 ? 'stable' : process.argv[flag + 1];
if (requested === undefined) throw new Error('--vscode needs a value');
const version =
  requested === 'minimum'
    ? JSON.parse(
        readFileSync(path.join(extensionPath, 'package.json'), 'utf8'),
      ).engines.vscode.replace(/^[^\d]*/, '')
    : requested;

// VS Code's IPC socket lives under the user-data dir and must fit in ~100
// characters, so on POSIX use /tmp, not the long per-user tmpdir.
const root = mkdtempSync(
  path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'vsh-'),
);
const workspace = path.join(root, 'w');
mkdirSync(workspace);
writeFileSync(
  path.join(workspace, 'main.tex'),
  '\\documentclass{article}\n\\begin{document}\nSmoke\n\\end{document}\n',
);

try {
  await runTests({
    version,
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: path.join(
      repoRoot,
      'scripts/vscode-host-e2e-suite.cjs',
    ),
    launchArgs: [
      workspace,
      '--user-data-dir',
      path.join(root, 'u'),
      '--extensions-dir',
      path.join(root, 'x'),
      '--disable-extensions',
    ],
  });
  console.log(`VS Code host e2e passed on ${version}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
