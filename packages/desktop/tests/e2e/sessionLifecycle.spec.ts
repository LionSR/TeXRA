import { hostname } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';

import { expect, test } from '@playwright/test';
import type { RunId } from '@shared/schemas';
import {
  loadDatabaseFixture,
  type DatabaseFixture,
} from '../../../../scripts/desktop-package-smoke-environment.mjs';

import {
  closeTexraApp,
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
          phase: 'waiting' as const,
        },
        {
          runId: ORPHAN_RUN,
          agent: 'e2e-orphan',
          phase: 'running' as const,
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
            isRemote: false,
            parent: null,
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
            type: 'status',
            aggregateId: id,
            phase: runFixture.phase,
            cause: runFixture.phase === 'waiting' ? 'wait' : 'lifecycle',
          },
        ]);
      }
      // These rows belong to a stopped writer. The next process must derive
      // interrupted presentation without rewriting the recorded phases.
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
            runId: (tab as HTMLElement & { stream: { id: string } }).stream.id,
            status: (tab as HTMLElement & { stream: { status: string } }).stream
              .status,
            group: (tab as HTMLElement & { stream: { group: string } }).stream
              .group,
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
