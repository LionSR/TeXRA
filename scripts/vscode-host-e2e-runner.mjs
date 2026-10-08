// Runs the built extension inside a real VS Code and checks it from the
// extension host (`vscode-host-e2e-suite.cjs`). Build first
// (`npm run compile:fast`); then:
//
//   node scripts/vscode-host-e2e-runner.mjs [--vscode stable|minimum|<x.y.z>]
//
// `minimum` is `engines.vscode` from the extension manifest, so the run also
// catches use of a VS Code API newer than the manifest claims.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
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
// The extension host's home: the TeXRA store and the background service the
// window starts live here, never in the developer's ~/.texra.
const home = path.join(root, 'h');
mkdirSync(home);
writeFileSync(
  path.join(workspace, 'main.tex'),
  '\\documentclass{article}\n\\begin{document}\nSmoke\n\\end{document}\n',
);

// A run that never finishes says why: the window's own logs (the extension
// host and TeXRA's output channels) and the service's, then fails. Without
// this a stuck window holds the job until CI cancels it, printing nothing.
const WATCHDOG_MS = 8 * 60_000;
const watchdog = setTimeout(() => {
  console.error(`VS Code host e2e did not finish within ${WATCHDOG_MS} ms`);
  // What the stuck window shows (a dialog that holds it open, say).
  if (process.platform === 'darwin') {
    mkdirSync(path.join(repoRoot, 'artifacts', 'vscode-e2e'), {
      recursive: true,
    });
    spawnSync('screencapture', [
      '-x',
      path.join(repoRoot, 'artifacts', 'vscode-e2e', 'stuck.png'),
    ]);
  }
  printLogs();
  // What is still alive, and which of it holds VS Code open.
  if (process.platform !== 'win32')
    console.error(
      spawnSync('ps', ['-axo', 'pid,ppid,pgid,etime,command'], {
        encoding: 'utf8',
      })
        .stdout.split('\n')
        .filter((line) => /Code|serve|node|vsh-/.test(line))
        .join('\n'),
    );
  // Whether the live service is what holds VS Code open: stop it, and
  // say whether VS Code then quits.
  stopService(path.join(home, '.texra', 'run', 'serve.json'));
  setTimeout(() => {
    const left = spawnSync('pgrep', ['-f', `user-data-dir ${root}/u`], {
      encoding: 'utf8',
    }).stdout.trim();
    console.error(
      left === ''
        ? 'VS Code quit once the service stopped'
        : `VS Code is still running after the service stopped (${left})`,
    );
    process.exit(1);
  }, 30_000);
}, WATCHDOG_MS);

try {
  await runTests({
    version,
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: path.join(
      repoRoot,
      'scripts/vscode-host-e2e-suite.cjs',
    ),
    extensionTestsEnv: { HOME: home, TEXRA_NO_TELEMETRY: '1' },
    launchArgs: [
      workspace,
      '--user-data-dir',
      path.join(root, 'u'),
      '--extensions-dir',
      path.join(root, 'x'),
      '--disable-extensions',
      // VS Code's safe storage on a mock keychain, not the login one: on a
      // CI runner the keychain's access dialog holds VS Code open after the
      // suite ends, so the run never finishes (the stuck runs' screenshot).
      '--use-mock-keychain',
      '--password-store=basic',
    ],
  });
  // The service the window started outlives it: its tasks keep running.
  const record = path.join(home, '.texra', 'run', 'serve.json');
  if (process.platform !== 'win32') {
    const { pid } = JSON.parse(readFileSync(record, 'utf8'));
    try {
      process.kill(pid, 0);
    } catch {
      throw new Error(`the service (pid ${pid}) did not outlive the window`);
    }
  }
  console.log(`VS Code host e2e passed on ${version}`);
} catch (error) {
  printLogs();
  throw error;
} finally {
  clearTimeout(watchdog);
  stopService(path.join(home, '.texra', 'run', 'serve.json'));
  rmSync(root, { recursive: true, force: true });
}

/** Stop the service a run started, when one wrote its record. */
function stopService(record) {
  try {
    process.kill(JSON.parse(readFileSync(record, 'utf8')).pid, 'SIGTERM');
  } catch {
    // No service was started, or it is gone already.
  }
}

/** Every log the window and the service wrote, for a run that failed. */
function printLogs() {
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.log')) files.push(full);
    }
  };
  walk(path.join(root, 'u', 'logs'));
  walk(path.join(home, '.texra', 'run'));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (text.trim() === '') continue;
    console.error(`----- ${file}\n${text.slice(-6000)}`);
  }
}
