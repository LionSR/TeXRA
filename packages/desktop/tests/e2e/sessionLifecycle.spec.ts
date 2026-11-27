import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Effect, Layer } from 'effect';

import type { RunId } from '@texra-ai/worldline/schemas';
import type { Database } from '../../../../scripts/fixtures/sessionDatabase';
import {
  loadDatabaseFixture,
  type DatabaseFixture,
} from '../../../../scripts/desktop-package-smoke-environment.mjs';
import { stopServices } from '../../../../scripts/texra-services.mjs';

import {
  box,
  closeTexraApp,
  dismissOnboarding,
  expect,
  findWorkspaceStoragePath,
  test,
  type LaunchedApp,
  type Profile,
} from './electronApp.js';
import { withStoreCopy } from './workspaceStorageFixture.js';

// One id per run: the aggregate's logical id is the run id, and the agent
// name the tab shows comes from the run's identity, not from the id.
const WAITING_RUN = 'a11ce1' as RunId;
const ORPHAN_RUN = 'baddad' as RunId;

/** Both canonical runs' rows and the store's last commit: a rewrite or a
 *  new row changes one of them. */
const canonicalRows = (fixture: DatabaseFixture) =>
  Effect.gen(function* () {
    const database = yield* fixture.Database;
    const types = fixture.SessionRowSchema.members.map(
      (schema) => schema.fields.type.literal,
    );
    return {
      commit: yield* database.currentCommit,
      runs: yield* Effect.forEach([WAITING_RUN, ORPHAN_RUN], (runId) =>
        database.readAggregate(runId, 0, types),
      ),
    };
  });

/** Open the same C1 database implementation used by the application. */
function inEventDatabase<A, E>(
  fixture: DatabaseFixture,
  storagePath: string,
  operation: Effect.Effect<A, E, Database>,
) {
  return Effect.runPromise(
    operation.pipe(
      Effect.provide(
        fixture.databaseLayer('persistent').pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(fixture.SessionWorkspace)({ storage: storagePath }),
              fixture.nodePlatformServices,
              fixture.appNamespaceLayer,
              // The canonical runs write no plugin rows.
              Layer.succeed(fixture.ToolRegistry)(fixture.toolTable([])),
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
        const id = runFixture.runId;
        yield* database.appendAll([
          {
            type: 'run.start',
            maxCostUsd: null,
            aggregateId: id,
            identity: { kind: 'agent', agent: runFixture.agent },
            takesFollowUps: true,
            parent: null,
            provenance: null,
            worktree: null,
            grants: { own: {}, goal: [] },
          },
          { type: 'run.activate', aggregateId: id },
          {
            type: 'response.finalized',
            aggregateId: id,
            text: `Saved history for ${runFixture.agent}.`,
          },
          {
            type: 'run.position',
            aggregateId: id,
            payload: { at: runFixture.step, turn: 0 },
          },
        ]);
      }
      // These rows belong to a stopped writer. The next process must read
      // each run's status from its recorded loop position, without
      // rewriting a single row.
      return yield* canonicalRows(fixture);
    }),
  );
}

async function processId(launched: LaunchedApp): Promise<number> {
  return launched.app.evaluate(() => process.pid);
}

/**
 * Write both canonical runs into `profile`'s project store between launches:
 * once the app has quit, its service still holds the store, so it is
 * stopped first.
 */
async function seedCanonicalRuns(profile: Profile) {
  stopServices(profile.dataRoot, { timeoutMs: 30_000 });
  const storagePath = await findWorkspaceStoragePath(profile);
  const fixture = await loadDatabaseFixture();
  const persisted = await writeCanonicalRunFixtures(fixture, storagePath);
  return { fixture, storagePath, persisted };
}

/** `runId`'s row in the project's run list. */
const railRow = (launched: LaunchedApp, runId: RunId) =>
  launched.page
    .locator('.shell-project-runs run-tab')
    .filter({ has: launched.page.locator(`[data-run="${runId}"]`) });

test('macOS window close detaches and activation reopens in the same process', async ({
  launch,
}) => {
  test.skip(
    process.platform !== 'darwin',
    'macOS keeps the process windowless',
  );

  const launched = await launch();
  const initialPage = launched.page;
  const initialPid = await processId(launched);

  const browserWindow = await launched.app.browserWindow(initialPage);
  await browserWindow.evaluate((window) => window.close());
  await expect.poll(() => launched.app.windows().length).toBe(0);

  const reopenedPagePromise = launched.app.waitForEvent('window');
  await launched.app.evaluate(({ app }) => app.emit('activate'));
  const reopenedPage = await reopenedPagePromise;
  await reopenedPage.waitForSelector('#app', { state: 'attached' });

  expect(reopenedPage).not.toBe(initialPage);
  expect(await processId(launched)).toBe(initialPid);
});

test('a new desktop process loads waiting and orphaned histories without rewriting them', async ({
  profile,
  launch,
}) => {
  const first = await launch();
  const firstPid = await processId(first);
  await closeTexraApp(first);
  const { fixture, storagePath, persisted } = await seedCanonicalRuns(profile);

  const launched = await launch();
  expect(await processId(launched)).not.toBe(firstPid);
  // Nothing holds either after the restart: the run that waited for a
  // message reads idle, and the one cut inside its turn reads interrupted.
  for (const [runId, status] of [
    [WAITING_RUN, /Status: Idle/],
    [ORPHAN_RUN, /Status: Interrupted/],
  ] as const)
    await expect(
      railRow(launched, runId).getByRole('button', { name: status }),
    ).toBeVisible();
  // The service holds the store: its rows are read from a copy.
  const reloaded = await withStoreCopy(storagePath, (copy) =>
    inEventDatabase(fixture, copy, canonicalRows(fixture)),
  );
  expect(reloaded).toEqual(persisted);
});

test('the rail deletes a finished conversation at once, and it stays deleted', async ({
  profile,
  launch,
}) => {
  await closeTexraApp(await launch());
  await seedCanonicalRuns(profile);

  let currentLaunch = await launch();
  await dismissOnboarding(currentLaunch.page);
  const row = railRow(currentLaunch, WAITING_RUN);
  await expect(row).toHaveCount(1);
  const page = currentLaunch.page;
  const newTask = page.locator('#shellNewTask');
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
  const rename = currentLaunch.page
    .locator('run-header wa-dropdown-item')
    .filter({ hasText: 'Rename…' });
  await expect(rename).toBeVisible();
  const menuGeometry = await currentLaunch.page
    .locator('run-header wa-dropdown-item')
    .evaluateAll((items) =>
      items
        .filter((item) => item.querySelector('[slot="icon"]'))
        .map((item) => ({
          labelX:
            item.shadowRoot?.querySelector('#label')?.getBoundingClientRect()
              .x ?? Number.NaN,
          iconWidth:
            item.querySelector('[slot="icon"]')?.getBoundingClientRect()
              .width ?? Number.NaN,
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

  // The project and task menus occupy the same action column.
  await row.hover();
  const rowMenu = row.locator('#run-tab-actions');
  const centers = await Promise.all([
    box(currentLaunch.page.locator('#shellProjectAdd')),
    box(
      currentLaunch.page
        .locator('.shell-project-menu [slot="trigger"]')
        .first(),
    ),
    box(rowMenu),
  ]);
  const centerX = centers.map((found) => found.x + found.width / 2);
  expect(Math.max(...centerX) - Math.min(...centerX)).toBeLessThan(1);
  // A task's title starts where its project's name does.
  const titleBox = await box(row.locator('.tab-title'));
  const nameBox = await box(page.locator('.shell-project-name').first());
  expect(Math.abs(titleBox.x - nameBox.x)).toBeLessThan(1);
  await currentLaunch.page.screenshot({
    path: test.info().outputPath('rail-row-hover.png'),
    animations: 'disabled',
  });
  await rowMenu.click();
  await row.locator('wa-dropdown-item').filter({ hasText: 'Rename…' }).click();
  await row.locator('.tab-rename').fill('Renamed from the sidebar');
  await row.locator('.tab-rename').press('Enter');
  await expect(row.locator('.tab-title')).toHaveText(
    'Renamed from the sidebar',
  );
  await rowMenu.click();
  await row
    .locator('wa-dropdown-item')
    .filter({ hasText: /Delete (task|agent)/ })
    .click();
  await expect(row).toHaveCount(0);
  await expect(railRow(currentLaunch, ORPHAN_RUN)).toHaveCount(1);

  await currentLaunch.page
    .locator('.shell-project-menu [slot="trigger"]')
    .first()
    .click();
  await currentLaunch.page
    .locator('.shell-project-menu wa-dropdown-item')
    .filter({ hasText: 'Rename project…' })
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
  currentLaunch = await launch();
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
});

test("a command's output is drawn in the theme's terminal colours", async ({
  profile,
  launch,
}) => {
  await closeTexraApp(await launch());
  stopServices(profile.dataRoot, { timeoutMs: 30_000 });
  // The golden store's `golden_script` run holds a finished `bash` call
  // with output: the store the app made is replaced by it.
  const storagePath = await findWorkspaceStoragePath(profile);
  for (const name of readdirSync(storagePath))
    if (name.startsWith('texra.project-v1.db')) rmSync(join(storagePath, name));
  const store = new DatabaseSync(join(storagePath, 'texra.project-v1.db'));
  try {
    store.exec(
      readFileSync(
        resolve(
          import.meta.dirname,
          '../../../../src/test-kernel/fixtures/storage/golden-1.0.sql',
        ),
        'utf8',
      ),
    );
  } finally {
    store.close();
  }

  const { page } = await launch();
  await dismissOnboarding(page);
  await page
    .locator('.shell-project-runs run-tab')
    .getByRole('button', { name: /^golden_script · Status: Completed/ })
    .click();
  await page.locator('wa-details.work-fold .details-summary').click();
  await page
    .locator('.script-call wa-details.tool-use-details')
    .filter({ hasText: 'Say gathered' })
    .locator('.details-summary')
    .click();
  const rows = page.locator('terminal-output .xterm-rows');
  await expect(rows).toContainText('gathered');
  // The text is the terminal foreground token and the surface its
  // background token, as the terminal's own container resolves them: a
  // resolver that reads neither paints both black.
  const painted = await rows.evaluate((element) => {
    const container = element.closest('.terminal-container');
    if (!container) throw new Error('The terminal has no container.');
    const token = (name: string): string => {
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      container.append(probe);
      const { color } = getComputedStyle(probe);
      probe.remove();
      return color;
    };
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No canvas context.');
    // One spelling for both sides, whatever syntax each computes to.
    const spelled = (color: string): string => {
      context.fillStyle = color;
      return context.fillStyle;
    };
    const surface = element.closest('.xterm')?.querySelector('.xterm-viewport');
    if (!surface) throw new Error('The terminal has no viewport.');
    return {
      text: spelled(getComputedStyle(element).color),
      foreground: spelled(token('--wa-color-terminal-foreground')),
      surface: spelled(getComputedStyle(surface).backgroundColor),
      background: spelled(token('--wa-color-terminal-background')),
    };
  });
  expect(painted.text).toBe(painted.foreground);
  expect(painted.surface).toBe(painted.background);
  expect(painted.text).not.toBe(painted.surface);
  await page.screenshot({
    path: test.info().outputPath('command-output-light.png'),
  });
});
