// The desktop app is a client of the background TeXRA service (D1-D4): it
// starts the service from the bundle it ships and stays its client while it
// runs. A CLI of the same build shares that service; a CLI of a newer build
// retires it, and the open app reaches the newer one and lists its tasks
// again. A file a service task accepts into the project shows in the app's
// file tree, heard from the run's rows. The service outlives the app. Every host stamps the same build
// identity, so "newer" means the same thing to all of them.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
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

/** A CLI bundle of this tree, stamped as `build` when one is named; a
 *  newer build carries the scripted validation model. */
function buildCli(outfile: string, build?: string): void {
  const result = spawnSync(
    process.execPath,
    [join(CLI_ROOT, 'scripts', 'build-bundle.mjs')],
    {
      cwd: CLI_ROOT,
      env: {
        ...process.env,
        TEXRA_CLI_BUNDLE_OUTFILE: outfile,
        ...(build && {
          TEXRA_BUILD_VERSION: build,
          TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '1',
        }),
      },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0)
    throw new Error(`CLI build failed:\n${result.stdout}\n${result.stderr}`);
}

function cli(
  binary: string,
  home: string,
  args: readonly string[],
  env: Record<string, string> = {},
): string {
  const result = spawnSync(process.execPath, [binary, ...args], {
    env: {
      ...process.env,
      HOME: home,
      CI: '1',
      TEXRA_NO_TELEMETRY: '1',
      ...env,
    },
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

test('the desktop app shares the service with a CLI of its build, reaches the one a newer build starts, and lists a file its task accepts', async () => {
  test.setTimeout(300_000);
  // The app's data root is the scratch home's ~/.texra, the one root a
  // service serves, so the app, the service and the CLIs share it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'texra-e2e-service-')));
  const home = join(root, 'home');
  const dataRoot = join(home, '.texra');
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  const record = join(dataRoot, 'run', 'serve.json');
  // A task held at its model call, by the newer build's scripted model.
  const agents = join(dataRoot, 'v1', 'global-storage', 'custom_agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    join(agents, 'park-validation.yaml'),
    'name: park_validation\ndescription: Hold its model call until released.\n\nprompt: |\n  GOLDEN-PARK\n',
  );
  // A task that accepts `draft.tex` into the project as `accepted.tex`.
  writeFileSync(
    join(agents, 'accept-validation.yaml'),
    'name: accept_validation\ndescription: Accept one file into the workspace.\ntools: [accept_run_files]\n\nprompt: |\n  GOLDEN-ACCEPT\n',
  );
  const draft = 'Accepted by a task in the service.\n';
  writeFileSync(join(work, 'draft.tex'), draft);
  const flag = join(work, 'texra-validation.flag');
  writeFileSync(flag, 'texra-cli-run-validation\n');
  const scripted = {
    TEXRA_INTERNAL_VALIDATE_MODEL: '1',
    TEXRA_INTERNAL_VALIDATE_MODEL_FLAG: flag,
    TEXRA_INTERNAL_VALIDATE_GOLDEN: '1',
    OPENAI_API_KEY: 'texra-validation-fake-key',
  };
  // The CLI finds its resources beside its bin directory.
  const thisBuild = join(root, 'bin', 'texra.js');
  const nextBuild = join(root, 'bin', 'texra-next.js');
  symlinkSync(
    join(REPO_ROOT, 'packages', 'extension', 'resources'),
    join(root, 'resources'),
  );
  buildCli(thisBuild);
  buildCli(nextBuild, NEXT_BUILD);
  const pids = new Set<number>();
  try {
    const launched = await launchTexraApp({
      userDataPath: dataRoot,
      workspacePath: work,
      env: { HOME: home },
    });
    let artifact: Record<string, unknown>;
    try {
      await expect
        .poll(() => existsSync(record), { timeout: 60_000 })
        .toBe(true);
      const started = JSON.parse(readFileSync(record, 'utf8')) as {
        readonly pid: number;
        readonly version: string;
      };
      pids.add(started.pid);
      // A CLI of the same build finds the app's service, which the app is
      // a client of, and does not retire it.
      const shared = status(thisBuild, home);
      expect(shared.pid).toBe(started.pid);
      expect(shared.version).toBe(started.version);
      expect(shared.clients).toBeGreaterThan(0);
      const sharedTasks = JSON.parse(
        cli(thisBuild, home, ['tasks', 'list', '--output-format', 'json']),
      ) as unknown;
      // A newer build retires it while the app is open, and starts a task
      // in the app's project on the service it starts.
      const task = JSON.parse(
        cli(
          nextBuild,
          home,
          [
            'tasks',
            'start',
            'park_validation',
            '--model',
            'openai/gpt-5.6-sol',
            '--instruction',
            'Hold',
            '--output-format',
            'json',
            '--cwd',
            work,
          ],
          scripted,
        ),
      ) as { readonly runId: string };
      const next = status(nextBuild, home);
      pids.add(next.pid);
      expect(next.version).toBe(NEXT_BUILD);
      expect(next.pid).not.toBe(started.pid);
      for (let i = 0; i < 120 && alive(started.pid); i += 1) await sleep(250);
      const retired = !alive(started.pid);
      expect(retired).toBe(true);
      // The app reaches the newer service (its link and this status call)
      // and lists the task it runs.
      await expect
        .poll(() => status(nextBuild, home).clients, { timeout: 60_000 })
        .toBeGreaterThanOrEqual(2);
      const row = launched.page
        .locator('.shell-project-runs run-tab')
        .filter({ has: launched.page.locator(`[data-run="${task.runId}"]`) });
      await expect(row).toHaveCount(1, { timeout: 60_000 });
      await launched.page.screenshot({
        path: test.info().outputPath('desktop-reconnected.png'),
      });
      // A task in the service accepts a file into the project. The app hears
      // it from the run's rows, as every process that folds the run does,
      // and lists the file without a refresh.
      const treeRow = (path: string) =>
        launched.page.locator(`.desktop-editor-tree-row[data-path="${path}"]`);
      await launched.page.locator('#shellToggleSidePanel').click();
      await expect(treeRow('draft.tex')).toBeVisible({ timeout: 15_000 });
      await expect(treeRow('accepted.tex')).toHaveCount(0);
      // The service follows the project's own approval policy, which a
      // client can narrow but never widen: auto-approve it, as a window's
      // settings view would, so the acceptance needs no answer.
      const storage = join(dataRoot, 'v1', 'workspace-storage');
      const project = readdirSync(storage).find((name) =>
        name.startsWith('work-'),
      );
      writeFileSync(
        join(storage, project!, 'config.json'),
        `${JSON.stringify({ 'texra.approvalPolicy': 'yolo' })}\n`,
      );
      const accept = JSON.parse(
        cli(
          nextBuild,
          home,
          [
            'tasks',
            'start',
            'accept_validation',
            '--model',
            'openai/gpt-5.6-sol',
            '--instruction',
            `Accept draft.tex from ${task.runId}`,
            '--output-format',
            'json',
            '--cwd',
            work,
          ],
          scripted,
        ),
      ) as { readonly runId: string };
      await expect(treeRow('accepted.tex')).toBeVisible({ timeout: 60_000 });
      await launched.page.screenshot({
        path: test.info().outputPath('desktop-accepted-file.png'),
      });
      // On macOS, closing the window keeps the app; activating it reopens
      // the window, which waits for the service to attach it. The reopened
      // window lists the service's task, and the open is not refused.
      let reopenedWithService: boolean | 'not macOS' = 'not macOS';
      if (process.platform === 'darwin') {
        let mainErrors = '';
        launched.app.process().stderr?.on('data', (chunk: Buffer) => {
          mainErrors += chunk.toString();
        });
        const window = await launched.app.browserWindow(launched.page);
        await window.evaluate((closing) => closing.close());
        await expect.poll(() => launched.app.windows().length).toBe(0);
        const reopenedPage = launched.app.waitForEvent('window');
        await launched.app.evaluate(({ app }) => app.emit('activate'));
        const reopened = await reopenedPage;
        await expect(
          reopened
            .locator('.shell-project-runs run-tab')
            .filter({ has: reopened.locator(`[data-run="${task.runId}"]`) }),
        ).toHaveCount(1, { timeout: 60_000 });
        expect(mainErrors).not.toContain('could not be reopened');
        expect(launched.app.windows()).toHaveLength(1);
        reopenedWithService = true;
      }
      const accepted = readFileSync(join(work, 'accepted.tex'), 'utf8');
      const reconnected = status(nextBuild, home);
      const nextTasks = JSON.parse(
        cli(nextBuild, home, ['tasks', 'list', '--output-format', 'json']),
      ) as readonly { readonly runId: string }[];
      artifact = {
        // Pid-free, so a rerun diffs clean; the raw views follow.
        facts: {
          appAndCliShareOneService: shared.pid === started.pid,
          retiredByNewerBuild: retired,
          appReconnected: reconnected.clients >= 2,
          appListsTheNewerServicesTask: true,
          newerBuildVersion: next.version,
          cliListsTheTask: nextTasks.some((t) => t.runId === task.runId),
          serviceTaskAcceptedTheFile: accepted === draft,
          appListsTheAcceptedFile: true,
          acceptingTaskListed: nextTasks.some((t) => t.runId === accept.runId),
          reopenedWithService,
        },
        shared: { record: started, cliStatus: shared, cliTasks: sharedTasks },
        next: { status: reconnected, tasks: nextTasks },
      };
    } finally {
      await closeTexraApp(launched);
    }
    // The app quit; the service the newer build started still runs.
    const survived = status(nextBuild, home);
    expect(survived.online).toBe(true);
    writeFileSync(
      test.info().outputPath('service-handoff.json'),
      `${JSON.stringify(
        {
          ...artifact,
          facts: {
            ...(artifact.facts as object),
            survivedAppQuit: survived.online,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    // Release the held task, then stop every service this test started.
    writeFileSync(join(work, 'golden-park.release'), '');
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGTERM');
    cleanupDirectory(root);
  }
});
