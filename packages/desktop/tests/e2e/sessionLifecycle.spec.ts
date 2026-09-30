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
            category: 'toolUse',
            userFollowUpSupport: 'nativeInteractive',
            parent: null,
          },
          {
            type: 'run.activate',
            aggregateId: id,
            category: 'toolUse',
          },
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

test('the rail moves a conversation to the Trash, Undo and Restore bring it back, and Delete permanently asks', async () => {
  const { workspacePath, userDataPath } = createIsolatedProfile();
  let currentLaunch: LaunchedApp | undefined;
  const railRow = (launched: LaunchedApp, runId: RunId) =>
    launched.page
      .locator('.shell-project-runs run-tab')
      .filter({ has: launched.page.locator(`[data-run="${runId}"]`) });
  const trashDialog = (launched: LaunchedApp) =>
    launched.page.locator('wa-dialog.desktop-trash');
  const trashRow = (launched: LaunchedApp, runId: RunId) =>
    trashDialog(launched).locator(`.desktop-trash-row[data-run="${runId}"]`);
  // A shot waits for the menu, toast and dialog animations to settle (or be
  // cancelled by the next one).
  const shot = async (launched: LaunchedApp, name: string) => {
    await launched.page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      ),
    );
    await launched.page.screenshot({ path: test.info().outputPath(name) });
  };
  // The row's own ⋯ (shown on focus as on hover) opens its run menu;
  // Move to Trash acts at once.
  const moveToTrash = async (launched: LaunchedApp, runId: RunId) => {
    const row = railRow(launched, runId);
    await row.locator('#run-tab-select-button').focus();
    await row.locator('.tab-more').click();
    await row.locator('wa-dropdown-item[value="trashSession"]').click();
    await expect(row).toHaveCount(0);
  };
  const relaunch = async (launched: LaunchedApp) => {
    await closeTexraApp(launched);
    currentLaunch = undefined;
    currentLaunch = await launchTexraApp({ workspacePath, userDataPath });
    await dismissOnboarding(currentLaunch.page);
    await expect(railRow(currentLaunch, ORPHAN_RUN)).toHaveCount(1);
    return currentLaunch;
  };
  const openTrash = async (launched: LaunchedApp) => {
    await launched.page
      .locator('.shell-sidebar-footer .shell-sidebar-action')
      .filter({ hasText: 'Trash' })
      .click();
    await expect(trashDialog(launched)).toHaveJSProperty('open', true);
  };

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
    let launched = currentLaunch;
    const row = railRow(launched, WAITING_RUN);
    await expect(row).toHaveCount(1);

    // Right-click opens the same run menu as the row's ⋯.
    await row.click({ button: 'right' });
    await expect(row.locator('wa-dropdown.tab-menu')).toHaveJSProperty(
      'open',
      true,
    );
    await expect(
      row.locator('wa-dropdown-item[value="trashSession"]'),
    ).toBeVisible();
    await expect(
      row.locator('wa-dropdown-item[value="openRunStorageBtn"]'),
    ).toBeVisible();
    await shot(launched, 'rail-row-menu.png');
    await launched.page.keyboard.press('Escape');
    await expect(row.locator('wa-dropdown.tab-menu')).toHaveJSProperty(
      'open',
      false,
    );

    // Move to Trash asks nothing; Undo on its toast brings the row back.
    await moveToTrash(launched, WAITING_RUN);
    const toast = launched.page.locator('wa-toast-item.desktop-trash-toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('to Trash');
    await shot(launched, 'trash-undo-toast.png');
    await toast.locator('.desktop-trash-undo').click();
    await expect(railRow(launched, WAITING_RUN)).toHaveCount(1);

    // Trashed again, it stays trashed across a relaunch and is listed there.
    await moveToTrash(launched, WAITING_RUN);
    launched = await relaunch(launched);
    await expect(railRow(launched, WAITING_RUN)).toHaveCount(0);
    await openTrash(launched);
    await expect(trashRow(launched, WAITING_RUN)).toHaveCount(1);
    await expect(trashRow(launched, ORPHAN_RUN)).toHaveCount(0);
    await shot(launched, 'trash-view.png');

    // Restore puts it back in the rail and takes it out of the Trash.
    await trashRow(launched, WAITING_RUN)
      .locator('.desktop-trash-restore')
      .click();
    await expect(trashRow(launched, WAITING_RUN)).toHaveCount(0);
    await expect(railRow(launched, WAITING_RUN)).toHaveCount(1);
    await launched.page.keyboard.press('Escape');
    await expect(trashDialog(launched)).toHaveJSProperty('open', false);

    // Delete permanently asks first, then removes it for good.
    await moveToTrash(launched, WAITING_RUN);
    await openTrash(launched);
    await trashRow(launched, WAITING_RUN)
      .locator('.desktop-trash-delete')
      .click();
    await expect(
      trashRow(launched, WAITING_RUN).locator('.delete-confirm'),
    ).toBeVisible();
    await shot(launched, 'trash-delete-confirm.png');
    await trashRow(launched, WAITING_RUN)
      .locator('#confirmDeleteSession')
      .click();
    await expect(trashRow(launched, WAITING_RUN)).toHaveCount(0);
    await launched.page.keyboard.press('Escape');
    await expect(trashDialog(launched)).toHaveJSProperty('open', false);

    launched = await relaunch(launched);
    await expect(railRow(launched, WAITING_RUN)).toHaveCount(0);
    await openTrash(launched);
    await expect(
      trashDialog(launched).locator('.desktop-trash-row'),
    ).toHaveCount(0);
    // The artifact: the relaunched Trash, empty, over the rail without it.
    await shot(launched, 'trash-after-delete.png');
  } finally {
    if (currentLaunch) await closeTexraApp(currentLaunch);
    cleanupDirectory(workspacePath);
    cleanupDirectory(userDataPath);
  }
});
