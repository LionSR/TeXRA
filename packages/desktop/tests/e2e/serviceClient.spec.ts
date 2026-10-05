// The desktop app is a client of the background TeXRA service (D1-D4): it
// starts the service from the bundle it ships, stays its client while it
// runs, and leaves it running when it quits. A CLI of the same build shares
// that service; a CLI of a newer build retires it. Every host stamps the
// same build identity, so "newer" means the same thing to all of them.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { closeTexraApp, launchTexraApp } from './electronApp.js';
import { cleanupDirectory } from './workspaceStorageFixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const CLI_ROOT = join(REPO_ROOT, 'packages', 'cli');
const NEXT_BUILD = '999.0.0';

interface ServiceStatus {
  readonly pid: number;
  readonly version: string;
  readonly clients: number;
  readonly online: boolean;
}

/** A CLI bundle of this tree, stamped as `build` when one is named. */
function buildCli(outfile: string, build?: string): void {
  const result = spawnSync(
    process.execPath,
    [join(CLI_ROOT, 'scripts', 'build-bundle.mjs')],
    {
      cwd: CLI_ROOT,
      env: {
        ...process.env,
        TEXRA_CLI_BUNDLE_OUTFILE: outfile,
        ...(build && { TEXRA_BUILD_VERSION: build }),
      },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0)
    throw new Error(`CLI build failed:\n${result.stdout}\n${result.stderr}`);
}

function cli(binary: string, home: string, args: readonly string[]): string {
  const result = spawnSync(process.execPath, [binary, ...args], {
    env: { ...process.env, HOME: home, CI: '1', TEXRA_NO_TELEMETRY: '1' },
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(
      `texra ${args.join(' ')} exited ${result.status}:\n${result.stderr}`,
    );
  return result.stdout;
}

const status = (binary: string, home: string): ServiceStatus =>
  JSON.parse(
    cli(binary, home, ['service', 'status', '--output-format', 'json']),
  ) as ServiceStatus;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.skip(process.platform === 'win32', 'no service runs on Windows yet');

test('the desktop app starts the service, shares it with a CLI of its build, and leaves it to a newer one', async () => {
  test.setTimeout(240_000);
  // The app's data root is the scratch home's ~/.texra, the one root a
  // service serves, so the app, the service and the CLIs share it.
  const root = mkdtempSync(join(tmpdir(), 'texra-e2e-service-'));
  const home = join(root, 'home');
  const dataRoot = join(home, '.texra');
  mkdirSync(dataRoot, { recursive: true });
  const record = join(dataRoot, 'run', 'serve.json');
  // The CLI finds its resources beside its bin directory.
  const thisBuild = join(root, 'bin', 'texra.js');
  const nextBuild = join(root, 'bin', 'texra-next.js');
  symlinkSync(
    join(REPO_ROOT, 'packages', 'extension', 'resources'),
    join(root, 'resources'),
  );
  buildCli(thisBuild);
  buildCli(nextBuild, NEXT_BUILD);
  let servicePid: number | undefined;
  try {
    const launched = await launchTexraApp({
      userDataPath: dataRoot,
      env: { HOME: home },
    });
    try {
      await expect
        .poll(() => existsSync(record), { timeout: 60_000 })
        .toBe(true);
      const started = JSON.parse(readFileSync(record, 'utf8')) as {
        readonly pid: number;
        readonly version: string;
      };
      servicePid = started.pid;
      // A CLI of the same build finds the app's service, which the app is
      // a client of, and does not retire it.
      const shared = status(thisBuild, home);
      expect(shared.pid).toBe(started.pid);
      expect(shared.version).toBe(started.version);
      expect(shared.clients).toBeGreaterThan(0);
    } finally {
      await closeTexraApp(launched);
    }
    // The app quit; the service it started still runs.
    expect(alive(servicePid)).toBe(true);
    // A CLI of a newer build retires it and starts its own.
    cli(nextBuild, home, ['tasks', 'list']);
    const next = status(nextBuild, home);
    expect(next.version).toBe(NEXT_BUILD);
    expect(next.pid).not.toBe(servicePid);
    const retired = servicePid;
    servicePid = next.pid;
    for (let i = 0; i < 120 && alive(retired); i += 1) await sleep(250);
    expect(alive(retired)).toBe(false);
  } finally {
    if (servicePid !== undefined && alive(servicePid))
      process.kill(servicePid, 'SIGTERM');
    cleanupDirectory(root);
  }
});
