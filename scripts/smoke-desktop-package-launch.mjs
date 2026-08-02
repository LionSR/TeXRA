// Node.js imports
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Local imports - packaged smoke environment
import { buildDesktopSmokeEnvironment } from './desktop-package-smoke-environment.mjs';

// Local imports - smoke process helpers
import {
  appendBoundedLog,
  delay,
  formatExit,
  hasExited,
  stopChild,
  waitForTermination,
} from './smoke-process-utils.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const desktopRoot = join(repoRoot, 'packages', 'desktop');
const packagedRoot = join(desktopRoot, 'dist-packaged');
const desktopRequire = createRequire(join(desktopRoot, 'package.json'));
const { _electron: electron } = desktopRequire('playwright');

const READINESS_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;
const MAX_DIAGNOSTIC_CHARS = 32_000;
let diagnosticOutput = '';

function appendDiagnostic(label, value) {
  const text = String(value).trim();
  if (!text) return;
  diagnosticOutput = appendBoundedLog(
    diagnosticOutput,
    `[${label}] ${text}\n`,
    MAX_DIAGNOSTIC_CHARS,
  );
}

function createRuntimeFailureSignal() {
  let firstError;
  let resolveFirstError;
  const promise = new Promise((resolvePromise) => {
    resolveFirstError = resolvePromise;
  });
  return {
    get error() {
      return firstError;
    },
    promise,
    report(label, value) {
      const message = String(value).trim() || label;
      appendDiagnostic(label, message);
      if (firstError) return;
      firstError = new Error(`${label}: ${message}`);
      resolveFirstError(firstError);
    },
  };
}

function defaultPackagedExecutables() {
  if (process.platform === 'darwin') {
    const appExecutable = ['TeXRA.app', 'Contents', 'MacOS', 'TeXRA'];
    const localArchDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
    return [
      join(packagedRoot, 'mac-universal', ...appExecutable),
      join(packagedRoot, localArchDir, ...appExecutable),
    ];
  }
  if (process.platform === 'win32') {
    return [join(packagedRoot, 'win-unpacked', 'TeXRA.exe')];
  }
  if (process.platform === 'linux') {
    return [join(packagedRoot, 'linux-unpacked', 'texra')];
  }
  return [];
}

async function resolvePackagedExecutable(argv) {
  const appFlagIndex = argv.indexOf('--app');
  const appFlagValue = appFlagIndex === -1 ? undefined : argv[appFlagIndex + 1];
  if (appFlagIndex !== -1 && !appFlagValue) {
    throw new Error('Missing value after --app.');
  }

  const candidates = appFlagValue
    ? [resolve(appFlagValue)]
    : defaultPackagedExecutables();
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // Try the local architecture fallback on macOS.
    }
  }

  const expectedPaths =
    candidates.length > 0
      ? candidates.map((candidate) => `- ${candidate}`).join('\n')
      : '- pass --app <executable> on this platform';
  throw new Error(
    `Packaged desktop executable was not found.\n${expectedPaths}\n` +
      'Package the desktop app before running the smoke.',
  );
}

async function createIsolation(root) {
  const profile = join(root, 'profile');
  const paths = {
    profile,
    userData: join(profile, 'user-data'),
    workspace: join(root, 'workspace'),
  };
  await Promise.all(
    Object.values(paths).map((path) => mkdir(path, { recursive: true })),
  );
  return paths;
}

function observeApplication(application, runtimeFailure) {
  const child = application.process();
  child.on('error', (error) => {
    runtimeFailure.report('process error', errorMessage(error));
  });
  child.stdout?.on('data', (chunk) => appendDiagnostic('stdout', chunk));
  child.stderr?.on('data', (chunk) => appendDiagnostic('stderr', chunk));
  application.on('console', (message) => {
    const label = `main ${message.type()}`;
    if (message.type() === 'error') {
      runtimeFailure.report(label, message.text());
    } else {
      appendDiagnostic(label, message.text());
    }
  });

  const observedPages = new WeakSet();
  const observeNewPage = (page) => {
    if (observedPages.has(page)) return;
    observedPages.add(page);
    observePage(page, runtimeFailure);
  };
  const context = application.context();
  context.on('page', observeNewPage);
  for (const page of context.pages()) observeNewPage(page);
}

function observePage(page, runtimeFailure) {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      appendDiagnostic(`renderer ${message.type()}`, message.text());
    }
  });
  page.on('pageerror', (error) => {
    runtimeFailure.report('renderer exception', error.message);
  });
  page.on('crash', () => runtimeFailure.report('renderer', 'page crashed'));
}

async function waitForReadiness(application) {
  const isPackaged = await application.evaluate(({ app }) => app.isPackaged);
  if (!isPackaged) {
    throw new Error('Electron main process reported app.isPackaged = false.');
  }

  const page = await application.firstWindow({ timeout: 0 });
  const handle = await page.waitForFunction(
    () => {
      // The renderer mounts into `<main id="app">` (renderer/index.html);
      // there is no `.desktop-shell` element, so keying readiness off one
      // could never resolve.
      const shell = document.querySelector('main#app');
      const mainApp = document.querySelector(
        'main-app[data-desktop-view="main"]',
      );
      const shellReady =
        shell instanceof HTMLElement &&
        shell.isConnected &&
        shell.getClientRects().length > 0 &&
        window.getComputedStyle(shell).visibility !== 'hidden';
      const mainAppReady =
        mainApp instanceof HTMLElement &&
        mainApp.isConnected &&
        (mainApp.shadowRoot?.childElementCount ?? 0) > 0;
      const theme = document.body.dataset.vscodeThemeKind;
      const themeReady =
        theme === 'dark' || theme === 'light' || theme === 'high-contrast';
      return shellReady && mainAppReady && themeReady ? { theme } : false;
    },
    undefined,
    { polling: 100, timeout: 0 },
  );
  const readiness = await handle.jsonValue();
  await handle.dispose();
  return readiness;
}

async function closeApplication(application, exitPromise) {
  const child = application.process();
  if (hasExited(child)) return;

  let closeFailure = await Promise.race([
    application.close().then(
      () => null,
      (error) => error,
    ),
    delay(SHUTDOWN_GRACE_MS).then(
      () => new Error('ElectronApplication.close() timed out.'),
    ),
  ]);
  if (!closeFailure) {
    if (hasExited(child)) return;
    const exitObserved = await Promise.race([
      exitPromise.then(() => true),
      delay(SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (exitObserved && hasExited(child)) return;
    closeFailure = new Error(
      'ElectronApplication.close() completed before the process exited.',
    );
  }

  if (hasExited(child)) return;

  appendDiagnostic(
    'teardown',
    `graceful close did not complete: ${errorMessage(closeFailure)}`,
  );
  appendDiagnostic(
    'teardown',
    'forcing the Electron process to stop after graceful close failed',
  );
  await stopChild(child, exitPromise, {
    graceMs: SHUTDOWN_GRACE_MS,
    label: 'Packaged app',
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

let executablePath;
let temporaryRoot;
let application;
let exitPromise;
let readiness;
let failure;
let phase = 'resolving packaged executable';

try {
  executablePath = await resolvePackagedExecutable(process.argv.slice(2));
  phase = 'creating isolated profile and workspace';
  temporaryRoot = await mkdtemp(join(tmpdir(), 'texra-package-smoke-'));
  const paths = await createIsolation(temporaryRoot);

  phase = 'launching packaged Electron app';
  application = await electron.launch({
    executablePath,
    args: ['--texra-workspace-path', paths.workspace],
    cwd: paths.workspace,
    env: buildDesktopSmokeEnvironment(process.env, paths),
    timeout: READINESS_TIMEOUT_MS,
  });

  const child = application.process();
  const runtimeFailure = createRuntimeFailureSignal();
  observeApplication(application, runtimeFailure);
  exitPromise = waitForTermination(child);
  phase = 'waiting for packaged desktop readiness';

  const outcome = await Promise.race([
    waitForReadiness(application).then(
      (value) => ({ kind: 'ready', value }),
      (error) => ({ kind: 'failure', error }),
    ),
    exitPromise.then((exit) => ({ kind: 'exit', exit })),
    runtimeFailure.promise.then((error) => ({ kind: 'failure', error })),
    delay(READINESS_TIMEOUT_MS).then(() => ({ kind: 'timeout' })),
  ]);
  if (outcome.kind === 'failure') throw outcome.error;
  if (outcome.kind === 'exit') {
    const description = formatExit(outcome.exit);
    throw new Error(`Packaged app exited before readiness (${description}).`);
  }
  if (outcome.kind === 'timeout') {
    throw new Error(
      `TeXRA readiness was not reached within ${READINESS_TIMEOUT_MS}ms.`,
    );
  }
  readiness = outcome.value;
  if (runtimeFailure.error) throw runtimeFailure.error;
  if (hasExited(child)) {
    throw new Error('Packaged app exited while reporting readiness.');
  }
} catch (error) {
  failure = { error, phase };
} finally {
  if (application) {
    try {
      exitPromise ??= waitForTermination(application.process());
      await closeApplication(application, exitPromise);
    } catch (error) {
      if (failure) {
        appendDiagnostic('teardown', errorMessage(error));
      } else {
        failure = { error, phase: 'closing packaged Electron app' };
      }
    }
  }

  if (temporaryRoot) {
    try {
      await rm(temporaryRoot, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 100,
      });
    } catch (error) {
      if (failure) {
        appendDiagnostic('cleanup', errorMessage(error));
      } else {
        failure = { error, phase: 'removing temporary smoke directories' };
      }
    }
  }
}

if (failure) {
  console.error(
    `Desktop package launch smoke failed while ${failure.phase}: ${errorMessage(
      failure.error,
    )}`,
  );
  if (executablePath) console.error(`Executable: ${executablePath}`);
  if (diagnosticOutput.trim()) {
    console.error(`Diagnostics:\n${diagnosticOutput.trim()}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Desktop package launch smoke passed: packaged app reached TeXRA readiness (${readiness.theme}) at ${executablePath}.`,
  );
}
