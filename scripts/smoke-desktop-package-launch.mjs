import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_TIMEOUT_MS = 8_000;
const SHUTDOWN_GRACE_MS = 3_000;
const MAX_LOG_CHARS = 256_000;
const fatalLogPatterns = [
  {
    label: 'VS Code runtime import',
    pattern:
      /Cannot find (?:module|package) ['"]vscode['"]|ERR_MODULE_NOT_FOUND.*['"]vscode['"]|from ['"]vscode['"]/i,
  },
  {
    label: 'desktop startup failure',
    pattern: /Failed to start TeXRA desktop/i,
  },
  {
    label: 'unhandled runtime exception',
    pattern: /Uncaught Exception|UnhandledPromiseRejection/i,
  },
];

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultPackagedExecutable() {
  if (process.platform !== 'darwin') return undefined;
  const archDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  return join(
    repoRoot,
    'packages',
    'desktop',
    'dist-packaged',
    archDir,
    'TeXRA.app',
    'Contents',
    'MacOS',
    'TeXRA',
  );
}

function parseAppPath(argv) {
  const appFlagIndex = argv.indexOf('--app');
  if (appFlagIndex === -1) return defaultPackagedExecutable();
  const value = argv[appFlagIndex + 1];
  if (!value) {
    throw new Error('Missing value after --app.');
  }
  return resolve(value);
}

function appendBoundedLog(current, chunk) {
  const next = current + chunk.toString('utf8');
  return next.length > MAX_LOG_CHARS ? next.slice(-MAX_LOG_CHARS) : next;
}

async function assertExecutableExists(executablePath) {
  if (!executablePath) {
    throw new Error(
      'No default packaged app path is available on this platform. Pass --app <executable>.',
    );
  }
  try {
    await access(executablePath);
  } catch (error) {
    throw new Error(
      [
        `Packaged desktop executable was not found: ${executablePath}`,
        'Run `npm run desktop:package:local` first.',
        error instanceof Error ? error.message : String(error),
      ].join('\n'),
    );
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function waitForClose(child) {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref();
  });
}

function findFatalLog(output) {
  return fatalLogPatterns.find(({ pattern }) => pattern.test(output));
}

function formatOutput(output) {
  return output.trim().length > 0 ? output.trim() : '(no output)';
}

function formatExit(exit) {
  return exit.signal ?? `code ${exit.code}`;
}

function failIfFatalLog(output) {
  const fatalLog = findFatalLog(output);
  if (!fatalLog) return false;

  console.error(`Desktop launch smoke failed: ${fatalLog.label}.`);
  console.error(formatOutput(output));
  process.exit(1);
}

function failEarlyExit(exit, timeoutMs, output) {
  failIfFatalLog(output);
  console.error(
    `Desktop launch smoke failed: app exited before ${timeoutMs}ms with ${formatExit(
      exit,
    )}.`,
  );
  console.error(formatOutput(output));
  process.exit(1);
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExitOrTimeout(exitPromise, timeoutMs) {
  return Promise.race([
    exitPromise.then((exit) => ({ exit })),
    delay(timeoutMs).then(() => ({ timeout: true })),
  ]);
}

async function readPendingExit(exitPromise) {
  const result = await Promise.race([
    exitPromise.then((exit) => ({ exit })),
    new Promise((resolve) => {
      setImmediate(() => resolve({}));
    }),
  ]);
  return result.exit;
}

async function stopChild(child, exitPromise) {
  if (hasExited(child)) return exitPromise;
  child.kill('SIGTERM');
  const gracefulExit = await waitForExitOrTimeout(
    exitPromise,
    SHUTDOWN_GRACE_MS,
  );
  if (!gracefulExit.timeout) return gracefulExit.exit;

  child.kill('SIGKILL');
  const forcedExit = await waitForExitOrTimeout(exitPromise, SHUTDOWN_GRACE_MS);
  if (!forcedExit.timeout) return forcedExit.exit;

  throw new Error(
    `Packaged app did not exit within ${SHUTDOWN_GRACE_MS}ms after SIGKILL.`,
  );
}

const executablePath = parseAppPath(process.argv.slice(2));
const timeoutMs = readPositiveNumber(
  process.env.TEXRA_DESKTOP_LAUNCH_SMOKE_MS,
  DEFAULT_TIMEOUT_MS,
);

await assertExecutableExists(executablePath);

const child = spawn(executablePath, [], {
  cwd: repoRoot,
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk) => {
  output = appendBoundedLog(output, chunk);
});
child.stderr.on('data', (chunk) => {
  output = appendBoundedLog(output, chunk);
});

const exitPromise = waitForExit(child);
const closePromise = waitForClose(child);
const result = await waitForExitOrTimeout(exitPromise, timeoutMs);

if (result.timeout) {
  if (hasExited(child)) {
    result.exit = await exitPromise;
  } else {
    result.exit = await readPendingExit(exitPromise);
    if (!result.exit) {
      await stopChild(child, exitPromise);
    }
  }
}

await closePromise;

if (result.exit) {
  failEarlyExit(result.exit, timeoutMs, output);
}

failIfFatalLog(output);

console.log(
  `Desktop launch smoke passed for ${executablePath} after ${timeoutMs}ms.`,
);
if (output.trim().length > 0) {
  console.log(formatOutput(output));
}
