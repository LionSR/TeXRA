import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendBoundedLog,
  formatExit,
  formatOutput,
  hasExited,
  readPendingExit,
  readPositiveNumber,
  stopChild,
  waitForClose,
  waitForExit,
  waitForExitOrTimeout,
} from './smoke-process-utils.mjs';

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
    pattern: /Failed to start TeXRA desktop|Fatal TeXRA desktop error/i,
  },
  {
    label: 'unhandled runtime exception',
    pattern: /Uncaught Exception|UnhandledPromiseRejection/i,
  },
  {
    label: 'esbuild dynamic require failure',
    pattern: /Dynamic require of ["'][^"']+["'] is not supported/i,
  },
  {
    label: 'constructor startup failure',
    pattern: /TypeError: .* is not a constructor/i,
  },
  {
    label: 'packaged asset load failure',
    pattern:
      /Failed to load URL:.*ERR_FILE_NOT_FOUND|Unable to load preload script|preload\/index\.cjs not found/i,
  },
];

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

function findFatalLog(output) {
  return fatalLogPatterns.find(({ pattern }) => pattern.test(output));
}

function failIfFatalLog(output) {
  const fatalLog = findFatalLog(output);
  if (!fatalLog) return;

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

const executablePath = parseAppPath(process.argv.slice(2));
const timeoutMs = readPositiveNumber(
  process.env.TEXRA_DESKTOP_LAUNCH_SMOKE_MS,
  DEFAULT_TIMEOUT_MS,
);

await assertExecutableExists(executablePath);

const smokeHome = await mkdtemp(join(tmpdir(), 'texra-desktop-smoke-home-'));
let output = '';
let result;

try {
  const child = spawn(executablePath, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '1',
      HOME: smokeHome,
      XDG_CONFIG_HOME: join(smokeHome, '.config'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    output = appendBoundedLog(output, chunk, MAX_LOG_CHARS);
  });
  child.stderr.on('data', (chunk) => {
    output = appendBoundedLog(output, chunk, MAX_LOG_CHARS);
  });

  const exitPromise = waitForExit(child);
  const closePromise = waitForClose(child);
  result = await waitForExitOrTimeout(exitPromise, timeoutMs);

  if (result.timeout) {
    if (hasExited(child)) {
      result.exit = await exitPromise;
    } else {
      result.exit = await readPendingExit(exitPromise);
      if (!result.exit) {
        await stopChild(child, exitPromise, {
          graceMs: SHUTDOWN_GRACE_MS,
          label: 'Packaged app',
        });
      }
    }
  }

  await closePromise;
} finally {
  await rm(smokeHome, { force: true, recursive: true });
}

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
