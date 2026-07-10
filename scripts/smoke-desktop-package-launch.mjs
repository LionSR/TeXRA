import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  appendBoundedLog,
  delay,
  formatExit,
  hasExited,
  stopChild,
  waitForExit,
} from './smoke-process-utils.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const desktopRoot = join(repoRoot, 'packages', 'desktop');
const packagedRoot = join(desktopRoot, 'dist-packaged');
const desktopRequire = createRequire(join(desktopRoot, 'package.json'));
const { _electron: electron } = desktopRequire('playwright');

const READINESS_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;
const MAX_DIAGNOSTIC_CHARS = 32_000;
const SENSITIVE_ENV_PREFIXES = [
  'APPLE_',
  'AZURE_',
  'CSC_',
  'DESKTOP_MACOS_',
  'DESKTOP_WINDOWS_',
  'TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_',
  'WIN_CSC_',
];

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
    return [join(packagedRoot, 'linux-unpacked', '@texradesktop')];
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
    } catch {
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
    artifacts: join(root, 'playwright-artifacts'),
  };
  await Promise.all(
    Object.values(paths).map((path) => mkdir(path, { recursive: true })),
  );
  return paths;
}

function childEnvironment(paths) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] != null),
  );
  for (const name of Object.keys(env)) {
    if (SENSITIVE_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      delete env[name];
    }
  }

  return {
    ...env,
    APPDATA: join(paths.profile, 'AppData', 'Roaming'),
    ELECTRON_ENABLE_LOGGING: '1',
    HOME: paths.profile,
    LOCALAPPDATA: join(paths.profile, 'AppData', 'Local'),
    NODE_ENV: 'production',
    TEXRA_DESKTOP_E2E_USER_DATA_PATH: paths.userData,
    TEXRA_DISABLE_KEYCHAIN: '1',
    TEXRA_NO_UPDATE_CHECK: '1',
    USERPROFILE: paths.profile,
    XDG_CACHE_HOME: join(paths.profile, '.cache'),
    XDG_CONFIG_HOME: join(paths.profile, '.config'),
  };
}

function observeExit(child) {
  if (hasExited(child)) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return waitForExit(child).catch((error) => {
    appendDiagnostic('process error', error.message);
    return { code: child.exitCode, signal: child.signalCode, error };
  });
}

function observeApplication(application) {
  const child = application.process();
  child.stdout?.on('data', (chunk) => appendDiagnostic('stdout', chunk));
  child.stderr?.on('data', (chunk) => appendDiagnostic('stderr', chunk));
  application.on('console', (message) => {
    appendDiagnostic(`main ${message.type()}`, message.text());
  });
}

function observePage(page) {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      appendDiagnostic(`renderer ${message.type()}`, message.text());
    }
  });
  page.on('pageerror', (error) => {
    appendDiagnostic('renderer exception', error.message);
  });
  page.on('crash', () => appendDiagnostic('renderer', 'page crashed'));
}

async function waitForReadiness(application) {
  const isPackaged = await application.evaluate(({ app }) => app.isPackaged);
  if (!isPackaged) {
    throw new Error('Electron main process reported app.isPackaged = false.');
  }

  const page = await application.firstWindow({ timeout: 0 });
  observePage(page);
  const handle = await page.waitForFunction(
    () => {
      const shell = document.querySelector('.desktop-shell');
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

  const closeFailure = await Promise.race([
    application.close().then(
      () => null,
      (error) => error,
    ),
    delay(SHUTDOWN_GRACE_MS).then(
      () => new Error('ElectronApplication.close() timed out.'),
    ),
  ]);
  if (!closeFailure) return;

  if (!hasExited(child)) {
    appendDiagnostic(
      'teardown',
      'graceful close failed; forcing the Electron process to stop',
    );
    await stopChild(child, exitPromise, {
      graceMs: SHUTDOWN_GRACE_MS,
      label: 'Packaged app',
    });
  }
  throw closeFailure;
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
    args: ['--texra-workspace', paths.workspace],
    artifactsDir: paths.artifacts,
    cwd: paths.workspace,
    env: childEnvironment(paths),
    timeout: READINESS_TIMEOUT_MS,
  });

  const child = application.process();
  observeApplication(application);
  exitPromise = observeExit(child);
  phase = 'waiting for packaged desktop readiness';

  readiness = await Promise.race([
    waitForReadiness(application),
    exitPromise.then((exit) => {
      const description = exit.error
        ? `process error: ${errorMessage(exit.error)}`
        : formatExit(exit);
      throw new Error(`Packaged app exited before readiness (${description}).`);
    }),
    delay(READINESS_TIMEOUT_MS).then(() => {
      throw new Error(
        `TeXRA readiness was not reached within ${READINESS_TIMEOUT_MS}ms.`,
      );
    }),
  ]);
  if (hasExited(child)) {
    throw new Error('Packaged app exited while reporting readiness.');
  }
} catch (error) {
  failure = { error, phase };
} finally {
  if (application) {
    try {
      exitPromise ??= observeExit(application.process());
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
