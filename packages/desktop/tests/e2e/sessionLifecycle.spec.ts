import { hostname } from 'node:os';
import { Effect, Layer } from 'effect';

import { expect, test } from '@playwright/test';
import type { RunId } from '@shared/schemas';
import {
  loadDatabaseFixture,
  type DatabaseFixture,
} from '../../../../scripts/desktop-package-smoke-environment.mjs';

import {
  closeTexraApp,
  dismissOnboarding,
  findWorkspaceStoragePath,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';
import {
  cleanupDirectory,
  createIsolatedProfile,
} from './workspaceStorageFixture.js';

// One id per run: the aggregate's logical id is the run id, and the agent
// name the tab shows comes from the run's identity, not from the id.
const WAITING_RUN = 'a11ce1' as RunId;
const ORPHAN_RUN = 'baddad' as RunId;

/** Open the same C1 database implementation used by the application. */
function inEventDatabase<A, E>(
  fixture: DatabaseFixture,
  storagePath: string,
  operation: Effect.Effect<A, E, import('@shared/session/database').Database>,
) {
  return Effect.runPromise(
    operation.pipe(
      Effect.provide(
        fixture
          .databaseLayer('persistent')
          .pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(fixture.WorkspaceRoots)({ storage: storagePath }),
                fixture.ProcessIdentity.layer(
                  JSON.stringify([hostname().toLowerCase(), process.pid, null]),
                ),
                fixture.nodePlatformServices,
              ),
            ),
          ),
      ),
    ),
  );
}

async function writeCanonicalRunFixtures(
  fixture: DatabaseFixture,
  storagePath: string,
) {
  return inEventDatabase(
    fixture,
    storagePath,
    Effect.gen(function* () {
      const database = yield* fixture.Database;
      const fixtures = [
        {
          runId: WAITING_RUN,
          agent: 'e2e-waiting',
          step: 'waiting' as const,
        },
        {
          runId: ORPHAN_RUN,
          agent: 'e2e-orphan',
          step: 'turn.begin' as const,
        },
      ];
      for (const runFixture of fixtures) {
        const id = fixture.aggregateId('run', runFixture.runId);
        yield* database.appendAll([
          {
            type: 'run.start',
            aggregateId: id,
            identity: { kind: 'agent', agent: runFixture.agent },
            userFollowUpSupport: 'nativeInteractive',
            parent: null,
            provenance: null,
          },
          { type: 'run.activate', aggregateId: id },
          {
            type: 'stage.start',
            aggregateId: id,
            id: `${runFixture.runId}-running-group`,
            label: 'Persisted round',
            kind: 'round',
          },
          {
            type: 'response.finalized',
            aggregateId: id,
            text: `Saved history for ${runFixture.agent}.`,
          },
          {
            type: 'run.position',
            aggregateId: id,
            payload: { family: 'toolUse', at: runFixture.step },
          },
        ]);
      }
      // These rows belong to a stopped writer. The next process must derive
      // interrupted presentation from the recorded loop position, without
      // rewriting a single row.
      yield* database.releaseClaims(
        fixtures.map((runFixture) =>
          fixture.aggregateId('run', runFixture.runId),
        ),
      );
      return yield* database.readAll(0);
    }),
  );
}

async function processId(launched: LaunchedApp): Promise<number> {
  return launched.app.evaluate(() => process.pid);
}

test('macOS window close detaches and activation reopens in the same process', async () => {
  test.skip(
    process.platform !== 'darwin',
    'macOS keeps the process windowless',
  );

  const launched = await launchTexraApp();
  const initialPage = launched.page;
  const initialPid = await processId(launched);

  try {
    const browserWindow = await launched.app.browserWindow(initialPage);
    await browserWindow.evaluate((window) => window.close());
    await expect.poll(() => launched.app.windows().length).toBe(0);

    const reopenedPagePromise = launched.app.waitForEvent('window');
    await launched.app.evaluate(({ app }) => app.emit('activate'));
    const reopenedPage = await reopenedPagePromise;
    await reopenedPage.waitForSelector('#app', { state: 'attached' });

    expect(reopenedPage).not.toBe(initialPage);
    expect(await processId(launched)).toBe(initialPid);
  } finally {
    await closeTexraApp(launched);
  }
});

test('a new desktop process hydrates waiting and orphaned histories without rewriting them', async () => {
  const { workspacePath, userDataPath } = createIsolatedProfile();
  let currentLaunch: LaunchedApp | undefined;

  try {
    currentLaunch = await launchTexraApp({ workspacePath, userDataPath });
    const firstPid = await processId(currentLaunch);
    await closeTexraApp(currentLaunch);
    currentLaunch = undefined;

    const storagePath = await findWorkspaceStoragePath({
      userDataPath,
      workspacePath,
    });
    const fixture = await loadDatabaseFixture(userDataPath);
    const persisted = await writeCanonicalRunFixtures(fixture, storagePath);

    currentLaunch = await launchTexraApp({ workspacePath, userDataPath });
    expect(await processId(currentLaunch)).not.toBe(firstPid);

    await expect
      .poll(async () =>
        currentLaunch!.page.locator('run-tab').evaluateAll((tabs) =>
          tabs.map((tab) => ({
            runId: (tab as HTMLElement & { run: { id: string } }).run.id,
            status: (tab as HTMLElement & { run: { status: string } }).run
              .status,
            group: (tab as HTMLElement & { run: { group: string } }).run.group,
          })),
        ),
      )
      .toEqual(
        expect.arrayContaining([
          { runId: WAITING_RUN, status: 'waiting', group: 'interrupted' },
          { runId: ORPHAN_RUN, status: 'running', group: 'interrupted' },
        ]),
      );
    const reloaded = await inEventDatabase(
      fixture,
      storagePath,
      Effect.gen(function* () {
        const database = yield* fixture.Database;
        return yield* database.readAll(0);
      }),
    );
    expect(reloaded).toEqual(persisted);
  } finally {
    if (currentLaunch) await closeTexraApp(currentLaunch);
    cleanupDirectory(workspacePath);
    cleanupDirectory(userDataPath);
  }
});

test('the rail deletes a finished conversation at once, and it stays deleted', async () => {
  const { workspacePath, userDataPath } = createIsolatedProfile();
  let currentLaunch: LaunchedApp | undefined;
  const railRow = (launched: LaunchedApp, runId: RunId) =>
    launched.page
      .locator('.shell-project-runs run-tab')
      .filter({ has: launched.page.locator(`[data-run="${runId}"]`) });

  try {
    currentLaunch = await launchTexraApp({ workspacePath, userDataPath });
    await closeTexraApp(currentLaunch);
    currentLaunch = undefined;

    const storagePath = await findWorkspaceStoragePath({
      userDataPath,
      workspacePath,
    });
    const fixture = await loadDatabaseFixture(userDataPath);
    await writeCanonicalRunFixtures(fixture, storagePath);

    currentLaunch = await launchTexraApp({ workspacePath, userDataPath });
    await dismissOnboarding(currentLaunch.page);
    const row = railRow(currentLaunch, WAITING_RUN);
    await expect(row).toHaveCount(1);
    const page = currentLaunch.page;
    const newTask = page
      .locator('.shell-sidebar-primary wa-button')
      .filter({ hasText: 'New task' });
    await newTask.click();
    const launcherInput = page.locator(
      'session-composer.launch-composer textarea',
    );
    await launcherInput.fill('A previous launch draft');
    await row.locator('[data-action="select"]').click();
    await newTask.click();
    await expect(launcherInput).toHaveValue('');
    await expect(page.locator('run-conversation')).toHaveCount(0);
    await page.reload();
    await expect(
      page.locator('session-composer.launch-composer textarea'),
    ).toHaveValue('');
    await expect(page.locator('run-conversation')).toHaveCount(0);

    // A task header's menu must open real actions, including after restoring
    // history. Verify both pointer activation and Escape/focus recovery.
    await row.locator('[data-action="select"]').click();
    const taskActions = currentLaunch.page.getByRole('button', {
      name: 'Task actions',
      exact: true,
    });
    await taskActions.click();
    const rename = currentLaunch.page.locator(
      'run-header wa-dropdown-item[value="renameTask"]',
    );
    await expect(rename).toBeVisible();
    const menuGeometry = await currentLaunch.page
      .locator('run-header wa-dropdown-item')
      .evaluateAll((items) =>
        items
          .filter((item) => item.querySelector('[slot="icon"]'))
          .map((item) => ({
            labelX: item
              .shadowRoot!.querySelector('#label')!
              .getBoundingClientRect().x,
            iconWidth: item
              .querySelector('[slot="icon"]')!
              .getBoundingClientRect().width,
          })),
      );
    expect(menuGeometry.length).toBeGreaterThan(1);
    for (const key of ['labelX', 'iconWidth'] as const) {
      const values = menuGeometry.map((item) => item[key]);
      expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1);
    }
    await currentLaunch.page.screenshot({
      path: test.info().outputPath('task-actions-menu.png'),
      animations: 'disabled',
    });
    await currentLaunch.page.keyboard.press('Escape');
    await expect(rename).toBeHidden();
    await taskActions.press('Enter');
    await expect(rename).toBeVisible();
    await rename.click();
    await expect(
      currentLaunch.page.locator('run-header .rename-input'),
    ).toBeVisible();
    await currentLaunch.page.keyboard.press('Escape');

    // The project and task menus occupy the same action column. Task names
    // and selected backgrounds use the project label's content column.
    await row.hover();
    const rowMenu = row.locator('#run-tab-actions');
    const centers = await Promise.all([
      currentLaunch.page.locator('#shellProjectAdd').boundingBox(),
      currentLaunch.page
        .locator('.shell-project-menu [slot="trigger"]')
        .first()
        .boundingBox(),
      rowMenu.boundingBox(),
    ]);
    const centerX = centers.map((box) => box!.x + box!.width / 2);
    expect(Math.max(...centerX) - Math.min(...centerX)).toBeLessThan(1);
    const nameBox = await currentLaunch.page
      .locator('.shell-project-name')
      .first()
      .boundingBox();
    const titleBox = await row.locator('.tab-title').boundingBox();
    expect(Math.abs(nameBox!.x - titleBox!.x)).toBeLessThan(1);
    const projectStatus = await page
      .locator('.shell-project-status')
      .boundingBox();
    const taskStatus = await row.locator('.tab-status').boundingBox();
    expect(
      Math.abs(
        projectStatus!.x +
          projectStatus!.width / 2 -
          taskStatus!.x -
          taskStatus!.width / 2,
      ),
    ).toBeLessThan(1);
    await currentLaunch.page.screenshot({
      path: test.info().outputPath('rail-row-hover.png'),
      animations: 'disabled',
    });
    await rowMenu.click();
    await row.locator('wa-dropdown-item[value="rename"]').click();
    await row.locator('.tab-rename').fill('Renamed from the sidebar');
    await row.locator('.tab-rename').press('Enter');
    await expect(row.locator('.tab-title')).toHaveText(
      'Renamed from the sidebar',
    );
    await rowMenu.click();
    await row.locator('.tab-remove').click();
    await expect(row).toHaveCount(0);
    await expect(railRow(currentLaunch, ORPHAN_RUN)).toHaveCount(1);

    await currentLaunch.page
      .locator('.shell-project-menu [slot="trigger"]')
      .first()
      .click();
    await currentLaunch.page
      .locator('.shell-project-menu wa-dropdown-item[value="rename"]')
      .click();
    const projectName = currentLaunch.page.getByRole('textbox', {
      name: 'Project display name',
    });
    await projectName.fill('Research workspace');
    await projectName.press('Enter');
    await expect(currentLaunch.page.locator('.shell-project-name')).toHaveText(
      'Research workspace',
    );
    await expect(
      currentLaunch.page.locator('.shell-workspace-project'),
    ).toHaveText('Research workspace');

    await closeTexraApp(currentLaunch);
    currentLaunch = await launchTexraApp({ workspacePath, userDataPath });
    await dismissOnboarding(currentLaunch.page);
    await expect(railRow(currentLaunch, ORPHAN_RUN)).toHaveCount(1);
    await expect(railRow(currentLaunch, WAITING_RUN)).toHaveCount(0);
    await expect(currentLaunch.page.locator('.shell-project-name')).toHaveText(
      'Research workspace',
    );
    // The artifact: the relaunched rail without the deleted conversation.
    await currentLaunch.page.screenshot({
      path: test.info().outputPath('rail-after-delete.png'),
    });
  } finally {
    if (currentLaunch) await closeTexraApp(currentLaunch);
    cleanupDirectory(workspacePath);
    cleanupDirectory(userDataPath);
  }
});
