import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Scope } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { refresh } from '@agent/index';
import { DESKTOP_WORKSPACE_COMMANDS } from '@desktop/shared/desktopWorkspaceMessages';
import { createDesktopWorkspaceIpc } from '@desktop/main/desktopWorkspaceIpc';
import { agentDocumentForPath } from '@desktop/main/desktopAgentDocuments';
import { agentDocumentTarget } from '@desktop/shared/desktopAgentDocument';
import type { DesktopBrowserViews } from '@desktop/main/desktopBrowserViews';
import type { DesktopPtyHost } from '@desktop/main/desktopPtyHost';
import { emitAppSignal } from '@eventBus/AppSignals';
import { REPO_ROOT } from '@test/support/repoScan';
import { testRuntime } from '@test/support/testProcessRuntime';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

let fixtureRoot = '';
let workspacePath = '';
let externalPath = '';
let missingExternalPath = '';

function createPtyHost(): DesktopPtyHost {
  return {
    create: vi.fn(async () => {
      throw new Error('Terminal is not used in this test.');
    }),
    get: vi.fn(() => undefined),
    disposeAll: vi.fn(),
  };
}

function createBrowserViews(): DesktopBrowserViews {
  return {
    open: vi.fn(),
    show: vi.fn(),
    hideAll: vi.fn(),
    close: vi.fn(),
    disposeAll: vi.fn(),
  };
}

type WorkspaceIpcOptions = Parameters<typeof createDesktopWorkspaceIpc>[1];

function createIpc(
  postToRenderer: (message: unknown) => void,
  overrides: Partial<WorkspaceIpcOptions> = {},
) {
  const runtime = testRuntime();
  const options: WorkspaceIpcOptions = {
    ptyHost: createPtyHost(),
    browserViews: createBrowserViews(),
    toWindowBounds: (bounds) => bounds,
    getWorkspacePath: () => workspacePath,
    ...overrides,
  };
  const ipc = createDesktopWorkspaceIpc({ postToRenderer }, options);
  // The IPC follows a process-global bus, so a fixture whose scope stayed
  // open would keep reacting to later tests' emits.
  const scope = Scope.makeUnsafe();
  liveScopes.push(scope);
  runtime.runSync(
    Effect.forkIn(ipc.followFilesWritten, scope, { startImmediately: true }),
  );
  return ipc;
}

const liveScopes: Scope.Closeable[] = [];

describe('desktop workspace IPC', () => {
  const tempDirs = useTempDirs();

  beforeEach(async () => {
    fixtureRoot = await makeTempDir('texra-workspace-ipc-', tempDirs);
    workspacePath = join(fixtureRoot, 'workspace');
    externalPath = join(fixtureRoot, 'external.txt');
    missingExternalPath = join(fixtureRoot, 'missing-external.txt');
    mkdirSync(workspacePath);
    mkdirSync(join(workspacePath, 'src', 'deep'), { recursive: true });
    mkdirSync(join(workspacePath, 'node_modules'));
    writeFileSync(join(workspacePath, 'paper.tex'), 'inside', 'utf8');
    writeFileSync(join(workspacePath, 'src', 'index.ts'), 'export {};', 'utf8');
    writeFileSync(
      join(workspacePath, 'src', 'deep', 'nested.ts'),
      'export {};',
      'utf8',
    );
    writeFileSync(externalPath, 'outside', 'utf8');
    symlinkSync(externalPath, join(workspacePath, 'linked.tex'));
    symlinkSync(
      missingExternalPath,
      join(workspacePath, 'dangling-linked.tex'),
    );
    const { installPlatform } = await import('@test/support/setupPlatform');
    await installPlatform({ workspacePath });
  });

  afterEach(() => {
    for (const scope of liveScopes.splice(0))
      testRuntime().runFork(Scope.close(scope, Exit.void));
  });

  // The file tree caches its listing and there is no filesystem watcher, so a
  // run that accepts output files would leave it stale without this notice.
  it.live(
    'tells the renderer to re-list only when a write lands inside the workspace',
    () =>
      Effect.gen(function* () {
        const filesChanged = Deferred.makeUnsafe<void>();
        const postToRenderer = vi.fn((message) => {
          if (
            (message as { command?: string }).command ===
            DESKTOP_WORKSPACE_COMMANDS.FILES_CHANGED
          ) {
            Deferred.doneUnsafe(filesChanged, Effect.void);
          }
        });
        createIpc(postToRenderer);
        // The IPC's subscription registers on its own fiber of this runtime;
        // let it reach the hub before publishing, or the writes below reach
        // nobody.
        yield* Effect.yieldNow;

        // Both writes are published before either is delivered, and one
        // subscriber sees them in publication order — so the single call
        // below is what proves the outside-the-workspace write was ignored.
        emitAppSignal('workspaceFilesWritten', {
          absolutePaths: [externalPath],
        });
        emitAppSignal('workspaceFilesWritten', {
          absolutePaths: [externalPath, join(workspacePath, 'paper.tex')],
        });

        yield* Deferred.await(filesChanged);
        expect(postToRenderer).toHaveBeenCalledExactlyOnceWith({
          command: DESKTOP_WORKSPACE_COMMANDS.FILES_CHANGED,
        });
      }),
  );

  it.effect(
    'reads regular workspace files but rejects symlink targets outside the workspace',
    () =>
      Effect.gen(function* () {
        const ipc = createIpc(vi.fn());
        const context = yield* testRuntime().contextEffect;

        expect(
          yield* ipc
            .file({ kind: 'read', path: 'paper.tex' })
            .pipe(Effect.provide(context)),
        ).toEqual({ kind: 'contents', contents: 'inside' });

        const refused = [
          ipc.file({ kind: 'read', path: 'linked.tex' }),
          ipc.file({
            kind: 'write',
            path: 'linked.tex',
            contents: 'overwritten',
          }),
          ipc.file({
            kind: 'write',
            path: 'dangling-linked.tex',
            contents: 'created outside',
          }),
        ];
        for (const program of refused) {
          const exit = yield* Effect.exit(
            program.pipe(Effect.provide(context)),
          );
          expect(Exit.isFailure(exit)).toBe(true);
        }
        expect(readFileSync(externalPath, 'utf8')).toBe('outside');
        expect(existsSync(missingExternalPath)).toBe(false);
      }),
  );

  it.effect(
    'keeps a UTF-8 byte-order mark when reading, so a save cannot delete it',
    () =>
      Effect.gen(function* () {
        const ipc = createIpc(vi.fn());
        const context = yield* testRuntime().contextEffect;

        writeFileSync(
          join(workspacePath, 'bom.tex'),
          Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from('hi', 'utf8'),
          ]),
        );
        expect(
          yield* ipc
            .file({ kind: 'read', path: 'bom.tex' })
            .pipe(Effect.provide(context)),
        ).toEqual({ kind: 'contents', contents: '\uFEFFhi' });
      }),
  );

  it.live(
    'edits custom agent YAML outside the workspace, but refuses packaged and unknown documents',
    () =>
      Effect.gen(function* () {
        const custom = join(fixtureRoot, 'custom');
        const builtIn = join(fixtureRoot, 'built-in');
        mkdirSync(custom);
        mkdirSync(builtIn);
        const original = readFileSync(
          join(REPO_ROOT, 'packages/extension/resources/agents/assistant.yaml'),
          'utf8',
        );
        const packagedPath = join(builtIn, 'assistant.yaml');
        const customPath = join(custom, 'assistant.yaml');
        writeFileSync(packagedPath, original);
        writeFileSync(customPath, original);
        const { installPlatform } = yield* Effect.promise(
          () => import('@test/support/setupPlatform'),
        );
        yield* Effect.promise(() =>
          installPlatform(
            { workspacePath },
            {
              agentDirectories: {
                custom: () => Effect.succeed(custom),
                customConfigured: () => Effect.succeed(true),
                builtIn: () => Effect.succeed(builtIn),
              },
            },
          ),
        );
        const context = yield* testRuntime().contextEffect;
        yield* refresh().pipe(Effect.provide(context));
        const ipc = createIpc(vi.fn());
        const target = agentDocumentTarget('custom', 'assistant');
        const packagedTarget = agentDocumentTarget('builtIn', 'assistant');
        expect(agentDocumentForPath(customPath)).toBe(target);
        // The custom copy shadows this name in the visible catalog; the
        // original must remain independently addressable and read-only.
        expect(agentDocumentForPath(packagedPath)).toBe(packagedTarget);
        expect(
          yield* ipc
            .file({ kind: 'read', path: target })
            .pipe(Effect.provide(context)),
        ).toEqual({ kind: 'contents', contents: original });
        yield* ipc
          .file({
            kind: 'write',
            path: target,
            contents: `${original}\n# edited\n`,
          })
          .pipe(Effect.provide(context));
        expect(readFileSync(customPath, 'utf8')).toBe(
          `${original}\n# edited\n`,
        );
        for (const path of [
          packagedTarget,
          agentDocumentTarget('custom', '../../external'),
        ]) {
          const exit = yield* Effect.exit(
            ipc
              .file({ kind: 'write', path, contents: 'rejected' })
              .pipe(Effect.provide(context)),
          );
          expect(Exit.isFailure(exit)).toBe(true);
        }
        expect(readFileSync(packagedPath, 'utf8')).toBe(original);
        expect(readFileSync(externalPath, 'utf8')).toBe('outside');
      }),
  );

  it.effect(
    'recreates a workspace file deleted after the editor loaded it',
    () =>
      Effect.gen(function* () {
        const ipc = createIpc(vi.fn());
        const context = yield* testRuntime().contextEffect;
        rmSync(join(workspacePath, 'paper.tex'));

        expect(
          yield* ipc
            .file({
              kind: 'write',
              path: 'paper.tex',
              contents: 'recovered buffer',
            })
            .pipe(Effect.provide(context)),
        ).toEqual({ kind: 'done' });
        expect(readFileSync(join(workspacePath, 'paper.tex'), 'utf8')).toBe(
          'recovered buffer',
        );
      }),
  );
});
