import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as scheduleTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = require('electron');
const packageManagerCli = process.env.npm_execpath;
const FORCE_STOP_DELAY_MS = 2_000;
const children = new Set();
let stopping = false;

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

function runPackageScript(script) {
  const invocation = packageManagerCommand(['run', script]);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnLogged(invocation.command, invocation.args);
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `${script} failed${signal ? ` after ${signal}` : ` with code ${code}`}`,
        ),
      );
    });
  });
}

async function waitForRenderer(url, vite) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (vite.exitCode != null) {
      throw new Error(`Vite exited before ${url} was ready.`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function findAvailablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address == null || typeof address === 'string') {
        server.close();
        rejectPort(new Error('Could not allocate a desktop development port.'));
        return;
      }
      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exitCode = exitCode;
  const forceStopTimer = scheduleTimeout(() => {
    for (const child of children) {
      if (child.exitCode == null) child.kill('SIGKILL');
    }
    process.exit(exitCode);
  }, FORCE_STOP_DELAY_MS);
  forceStopTimer.unref();
}

function isRelaunchArgs(message) {
  return (
    Array.isArray(message) &&
    message.length > 0 &&
    message.every((arg) => typeof arg === 'string')
  );
}

function launchElectron(rendererUrl, args) {
  let relaunchArgs;
  const electron = spawnLogged(electronPath, [packageRoot, ...args], {
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: rendererUrl,
      NODE_ENV: 'development',
      TEXRA_DESKTOP_DEV_SUPERVISED: '1',
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  electron.on('message', (message) => {
    if (isRelaunchArgs(message)) relaunchArgs = message;
  });
  electron.once('exit', (code) => {
    if (stopping) return;
    if (relaunchArgs) {
      launchElectron(rendererUrl, relaunchArgs);
      return;
    }
    stop(code ?? 0);
  });
}

async function main() {
  await runPackageScript('build:main');
  await runPackageScript('build:preload');
  const mainWatchInvocation = packageManagerCommand(['run', 'watch:main']);
  const mainWatch = spawnLogged(
    mainWatchInvocation.command,
    mainWatchInvocation.args,
  );
  mainWatch.once('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });

  const rendererPort = await findAvailablePort();
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  const viteInvocation = packageManagerCommand([
    'exec',
    'vite',
    '--config',
    'vite.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    String(rendererPort),
    '--strictPort',
  ]);
  const vite = spawnLogged(viteInvocation.command, viteInvocation.args);
  vite.once('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
  await waitForRenderer(rendererUrl, vite);

  launchElectron(rendererUrl, process.argv.slice(2));
}

process.once('SIGINT', () => stop(130));
process.once('SIGTERM', () => stop(143));

main().catch((error) => {
  console.error(error);
  stop(1);
});
