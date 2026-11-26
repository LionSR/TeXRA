import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as scheduleTimeout } from 'node:timers';

import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const packageRoot = resolve(import.meta.dirname, '..');
const electronPath = require('electron');
const packageManagerCli = process.env.npm_execpath;
const FORCE_STOP_DELAY_MS = 2_000;
const children = new Set();
let stopping = false;
/** The Vite dev server, once it listens. */
let renderer;

function spawnLogged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: packageRoot,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function packageManagerCommand(args) {
  if (packageManagerCli) {
    return {
      command: process.execPath,
      args: [packageManagerCli, ...args],
    };
  }
  return {
    command: process.platform === 'win32' ? 'corepack.cmd' : 'corepack',
    args: ['pnpm', ...args],
  };
}

async function runPackageScript(script) {
  const invocation = packageManagerCommand(['run', script]);
  const child = spawnLogged(invocation.command, invocation.args);
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) {
    throw new Error(
      `${script} failed${signal ? ` after ${signal}` : ` with code ${code}`}`,
    );
  }
}

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exitCode = exitCode;
  // Electron's window is the dev server's client, so the server closes
  // after Electron is told to stop.
  void renderer?.close();
  const forceStopTimer = scheduleTimeout(() => {
    for (const child of children) {
      if (child.exitCode == null) child.kill('SIGKILL');
    }
    process.exit(exitCode);
  }, FORCE_STOP_DELAY_MS);
  forceStopTimer.unref();
}

function launchElectron(rendererUrl, args) {
  const electron = spawnLogged(electronPath, [packageRoot, ...args], {
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: rendererUrl,
      NODE_ENV: 'development',
    },
  });
  electron.once('exit', (code) => {
    if (stopping) return;
    stop(code ?? 0);
  });
}

async function main() {
  await runPackageScript('build:main');
  await runPackageScript('build:preload');
  // Started as its own Node process, not through the package manager, so
  // the stop signal reaches the watcher instead of a wrapper that outlives it.
  const mainWatch = spawnLogged(process.execPath, [
    'esbuild.main.mjs',
    '--watch',
  ]);
  mainWatch.once('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });

  // Vite picks the free port and resolves `listen` once it serves, so there
  // is no port to probe for and no URL to poll.
  renderer = await createServer({
    configFile: resolve(packageRoot, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
  });
  await renderer.listen();
  const rendererUrl = renderer.resolvedUrls?.local[0];
  if (!rendererUrl) throw new Error('The Vite dev server opened no port.');
  renderer.printUrls();

  launchElectron(rendererUrl, process.argv.slice(2));
}

process.once('SIGINT', () => stop(130));
process.once('SIGTERM', () => stop(143));

main().catch((error) => {
  console.error(error);
  stop(1);
});
