// The desktop app is a client of the background TeXRA service (D1-D4): it
// starts the service from the bundle it ships and stays its client while it
// runs. A CLI of the same build shares that service; a CLI of a newer build
// retires it, and the open app reaches the newer one and lists its tasks
// again. A file a service task accepts into the project shows in the app's
// file tree, heard from the run's rows. The service outlives the app. Every host stamps the same build
// identity, so "newer" means the same thing to all of them. A tool edit a
// service task asks for is one request every window answers: changes made
// in the app that another window's answer leaves out stay with the app.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { closeTexraApp, expect, test } from './electronApp.js';
import {
  NEXT_BUILD,
  alive,
  buildCli,
  cli,
  scriptedModel,
  serviceStatus,
} from './serviceFixture.js';
import { cleanupDirectory, withStoreCopy } from './workspaceStorageFixture.js';

test.skip(process.platform === 'win32', 'no service runs on Windows yet');

test('the desktop app shares the service with a CLI of its build, reaches the one a newer build starts, and lists a file its task accepts', async ({
  profile,
  launch,
}) => {
  test.setTimeout(300_000);
  // The app's data root is the profile home's ~/.texra, the one root a
  // service serves, so the app, the service and the CLIs share it.
  const { home, dataRoot, workspaceRoot: work } = profile;
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
  const scripted = scriptedModel(work);
  const thisBuild = join(home, 'bin', 'texra.js');
  const nextBuild = join(home, 'bin', 'texra-next.js');
  buildCli(thisBuild);
  buildCli(nextBuild, { build: NEXT_BUILD });
  try {
    const launched = await launch();
    let artifact: Record<string, unknown>;
    try {
      // The service the app started, as its record names it.
      await expect
        .poll(() => serviceStatus(thisBuild, home).online, { timeout: 60_000 })
        .toBe(true);
      const started = serviceStatus(thisBuild, home);
      // A CLI of the same build finds the app's service, which the app is
      // a client of, and does not retire it.
      const shared = serviceStatus(thisBuild, home);
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
      const next = serviceStatus(nextBuild, home);
      expect(next.version).toBe(NEXT_BUILD);
      expect(next.pid).not.toBe(started.pid);
      await expect
        .poll(() => alive(started.pid), { timeout: 30_000 })
        .toBe(false);
      const retired = !alive(started.pid);
      // The app reaches the newer service (its link and this status call)
      // and lists the task it runs.
      await expect
        .poll(() => serviceStatus(nextBuild, home).clients, { timeout: 60_000 })
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
        name.startsWith('project-'),
      );
      if (project === undefined) throw new Error('The project has no storage.');
      writeFileSync(
        join(storage, project, 'config.json'),
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
      const reconnected = serviceStatus(nextBuild, home);
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
    const survived = serviceStatus(nextBuild, home);
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
    // Release the held task, so the services stop at teardown.
    writeFileSync(join(work, 'golden-park.release'), '');
  }
});

/** The tool edit `runId` asked for, as the project's store records it. */
function openedToolEdit(dataRoot: string, runId: string): string | undefined {
  const storage = join(dataRoot, 'v1', 'workspace-storage');
  const project = existsSync(storage)
    ? readdirSync(storage).find((name) => name.startsWith('project-'))
    : undefined;
  if (project === undefined) return undefined;
  // The service holds the store: its rows are read from a copy.
  return withStoreCopy(join(storage, project), (copy) => {
    const db = new DatabaseSync(join(copy, 'texra.db'), { readOnly: true });
    try {
      const row = db
        .prepare(
          `SELECT json_extract(e.data, '$.requestId') AS requestId FROM event e
           JOIN event_sequence s ON s.id = e.aggregate
           WHERE s.logical_id = ? AND e.type = 'request.opened'
             AND json_extract(e.data, '$.payload.kind') = 'toolEdit'`,
        )
        .get(runId) as { readonly requestId: string } | undefined;
      return row?.requestId;
    } finally {
      db.close();
    }
  });
}

test('a tool edit the app changed keeps its changes when another window answers it in the service, and a later answer is refused', async ({
  profile,
  launch,
}) => {
  test.setTimeout(300_000);
  const { home, dataRoot, workspaceRoot: work } = profile;
  // A task that asks to write a file the project does not have yet.
  const agents = join(dataRoot, 'v1', 'global-storage', 'custom_agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    join(agents, 'edit-validation.yaml'),
    'name: edit_validation\ndescription: Ask to write one file.\ntools: [write_file]\n\nprompt: |\n  GOLDEN-APPROVAL write_file {"path":"notes.txt","content":"beta\\n"}\n',
  );
  const scripted = scriptedModel(work);
  const nextBuild = join(home, 'bin', 'texra-next.js');
  const otherWindow = join(home, 'bin', 'service-host-harness.js');
  buildCli(nextBuild, { build: NEXT_BUILD });
  buildCli(otherWindow, { window: true });
  /** The other window approves the request: unchanged, or with `content`,
   *  the proposed file as that window left it. */
  const approveElsewhere = (
    runId: string,
    requestId: string,
    content?: string,
  ): string =>
    cli(otherWindow, home, [
      dataRoot,
      work,
      'approve',
      runId,
      requestId,
      ...(content === undefined ? [] : [content]),
    ]).trim();
  // The app stages each tool edit's copies in a directory of its own under
  // the temp directory it shares with this test: one that was not there
  // before is this task's.
  const previewDirs = () =>
    readdirSync(tmpdir()).filter((name) => name.startsWith('texra-tool-edit-'));
  const earlier = new Set(previewDirs());
  const stagedCopies = () =>
    previewDirs()
      .filter((dir) => !earlier.has(dir))
      .flatMap((dir) =>
        readdirSync(join(tmpdir(), dir))
          .filter((name) => name.endsWith('-proposed.txt'))
          .map((name) => join(tmpdir(), dir, name)),
      );
  let kept: string | undefined;
  try {
    const launched = await launch();
    try {
      // The app's dialogs are recorded, not shown.
      await launched.app.evaluate(({ dialog }) => {
        const shown: string[] = [];
        Object.assign(globalThis, { texraShownMessages: shown });
        Object.assign(dialog, {
          showMessageBox: (...args: unknown[]) => {
            shown.push((args.at(-1) as { readonly message: string }).message);
            return Promise.resolve({ response: 0, checkboxChecked: false });
          },
        });
      });
      const shownMessages = () =>
        launched.app.evaluate(
          () =>
            (globalThis as unknown as { texraShownMessages: string[] })
              .texraShownMessages,
        );
      // The app's own service; a newer build's task retires it, and the
      // app reaches the newer one, which runs the scripted model.
      await expect
        .poll(() => serviceStatus(nextBuild, home).online, { timeout: 60_000 })
        .toBe(true);
      const task = JSON.parse(
        cli(
          nextBuild,
          home,
          [
            'tasks',
            'start',
            'edit_validation',
            '--model',
            'openai/gpt-5.6-sol',
            '--instruction',
            'Write the notes',
            '--output-format',
            'json',
            '--cwd',
            work,
          ],
          scripted,
        ),
      ) as { readonly runId: string };
      await expect
        .poll(() => openedToolEdit(dataRoot, task.runId), { timeout: 60_000 })
        .toBeDefined();
      const requestId = openedToolEdit(dataRoot, task.runId) ?? '';
      // The app lists the task and stages the proposal; the user edits its
      // copy in the editor the app opens it in, which saves it to disk.
      const row = launched.page
        .locator('.shell-project-runs run-tab')
        .filter({ has: launched.page.locator(`[data-run="${task.runId}"]`) });
      await expect(row).toHaveCount(1, { timeout: 60_000 });
      await row.click();
      const card = launched.page.locator('tool-edit-request-panel');
      await expect(card).toHaveCount(1, { timeout: 30_000 });
      await expect.poll(stagedCopies, { timeout: 60_000 }).toHaveLength(1);
      const [copy] = stagedCopies();
      kept = copy;
      const proposal = readFileSync(copy, 'utf8');
      const edited = 'beta\nedited in the app\n';
      writeFileSync(copy, edited);
      await launched.page.screenshot({
        path: test.info().outputPath('desktop-edit-pending.png'),
      });
      // Another window approves the untouched proposal; the task writes it,
      // and the app's card goes with the answer.
      const answered = approveElsewhere(task.runId, requestId);
      expect(answered).toBe('DECIDED');
      const notes = join(work, 'notes.txt');
      await expect
        .poll(() => (existsSync(notes) ? readFileSync(notes, 'utf8') : null), {
          timeout: 60_000,
        })
        .toBe(proposal);
      await expect(card).toHaveCount(0, { timeout: 30_000 });
      // The app keeps the user's changes where its editor has them, and
      // says so once.
      const aboutNotes = async () =>
        (await shownMessages()).filter((message) =>
          message.includes('notes.txt'),
        );
      await expect.poll(aboutNotes, { timeout: 30_000 }).toHaveLength(1);
      const [notice] = await aboutNotes();
      expect(notice).toContain(copy);
      expect(readFileSync(copy, 'utf8')).toBe(edited);
      // A later answer from another window, with its own changes, is
      // refused: the recorded answer stands.
      const stale = approveElsewhere(
        task.runId,
        requestId,
        'beta\nedited in the other window\n',
      );
      expect(stale).toMatch(/^REFUSED Unavailable/);
      expect(readFileSync(notes, 'utf8')).toBe(proposal);
      await launched.page.screenshot({
        path: test.info().outputPath('desktop-after-other-window.png'),
      });
      const applied = readFileSync(notes, 'utf8');
      writeFileSync(
        test.info().outputPath('shared-preview-conflict.json'),
        `${JSON.stringify(
          {
            facts: {
              otherWindowApprovedUnchanged: answered === 'DECIDED',
              appCardWentWithTheAnswer: true,
              appliedIsTheProposal: applied === proposal,
              appEditKeptOnDisk: readFileSync(copy, 'utf8') === edited,
              appSaidWhereItIs: notice?.includes(copy) ?? false,
              laterAnswerRefused: stale.startsWith('REFUSED Unavailable'),
            },
            // Path-free, so a rerun diffs clean.
            proposal,
            applied,
            appEdit: edited,
            appNotice: notice?.replace(copy, '<the kept copy>'),
            laterAnswer: stale,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await closeTexraApp(launched);
    }
  } finally {
    if (kept !== undefined) cleanupDirectory(dirname(kept));
  }
});
