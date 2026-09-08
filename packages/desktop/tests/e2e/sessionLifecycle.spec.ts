import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Effect, Layer } from 'effect';

import { expect, test } from '@playwright/test';

import {
  closeTexraApp,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';
import {
  cleanupDirectory,
  createIsolatedProfile,
  findWorkspaceStoragePath,
} from './workspaceStorageFixture.js';

const WAITING_STREAM = 'e2e-waiting#a11ce1';
const WAITING_EXECUTION = 'a11ce1';
const ORPHAN_STREAM = 'e2e-orphan#baddad';
const ORPHAN_EXECUTION = 'baddad';

type DatabaseFixture = Pick<
  typeof import('@controllers/session/Database'),
  'databaseLayer'
> &
  Pick<typeof import('@controllers/session/WorkspaceRoots'), 'WorkspaceRoots'> &
  Pick<typeof import('@shared/session/database'), 'Database'> &
  Pick<typeof import('@shared/session/sessionEvents'), 'ProcessIdentity'> &
  Pick<typeof import('@shared/schemas'), 'aggregateId'>;

/** Playwright's ESM loader cannot directly import the root's CommonJS-shaped TS modules. */
async function loadDatabaseFixture(
  userDataPath: string,
): Promise<DatabaseFixture> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const bundle = join(userDataPath, 'session-database-fixture.mjs');
  await build({
    stdin: {
      contents: `
        export { databaseLayer } from '@controllers/session/Database';
        export { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
        export { Database } from '@shared/session/database';
        export { ProcessIdentity } from '@shared/session/sessionEvents';
        export { aggregateId } from '@shared/schemas';
      `,
      loader: 'ts',
      resolveDir: root,
    },
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.16',
    tsconfig: join(root, 'tsconfig.json'),
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  return import(pathToFileURL(bundle).href) as Promise<DatabaseFixture>;
}

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

async function writeCanonicalStreamFixtures(
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
          streamId: WAITING_STREAM,
          executionId: WAITING_EXECUTION,
          phase: 'waiting' as const,
        },
        {
          streamId: ORPHAN_STREAM,
          executionId: ORPHAN_EXECUTION,
          phase: 'running' as const,
        },
      ];
      for (const streamFixture of fixtures) {
        const id = fixture.aggregateId('stream', streamFixture.streamId);
        yield* database.appendAll([
          {
            type: 'run.start',
            aggregateId: id,
            executionId: streamFixture.executionId,
            identity: { kind: 'agent', agent: streamFixture.streamId },
            category: 'toolUse',
            userFollowUpSupport: 'nativeInteractive',
            isRemote: false,
          },
          {
            type: 'stage.start',
            aggregateId: id,
            id: `${streamFixture.streamId}-running-group`,
            label: 'Persisted round',
            kind: 'round',
          },
          {
            type: 'response.finalized',
            aggregateId: id,
            text: `Saved history for ${streamFixture.streamId}.`,
          },
          {
            type: 'status',
            aggregateId: id,
            phase: streamFixture.phase,
            cause: streamFixture.phase === 'waiting' ? 'wait' : 'lifecycle',
          },
        ]);
      }
      // These rows belong to a stopped writer. The next process must derive
      // interrupted presentation without rewriting the recorded phases.
      yield* database.releaseClaims(
        fixtures.map((streamFixture) =>
          fixture.aggregateId('stream', streamFixture.streamId),
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

    const storagePath = findWorkspaceStoragePath({
      userDataPath,
      workspacePath,
    });
    const fixture = await loadDatabaseFixture(userDataPath);
    const persisted = await writeCanonicalStreamFixtures(fixture, storagePath);

    currentLaunch = await launchTexraApp({ workspacePath, userDataPath });
    expect(await processId(currentLaunch)).not.toBe(firstPid);

    await expect
      .poll(async () =>
        currentLaunch!.page.locator('stream-tab').evaluateAll((tabs) =>
          tabs.map((tab) => ({
            streamId: (tab as HTMLElement & { stream: { id: string } }).stream
              .id,
            status: (tab as HTMLElement & { stream: { status: string } }).stream
              .status,
            group: (tab as HTMLElement & { stream: { group: string } }).stream
              .group,
          })),
        ),
      )
      .toEqual(
        expect.arrayContaining([
          { streamId: WAITING_STREAM, status: 'waiting', group: 'interrupted' },
          { streamId: ORPHAN_STREAM, status: 'running', group: 'interrupted' },
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
