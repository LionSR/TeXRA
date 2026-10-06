import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Exit, Scope } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunId } from '@shared/schemas';
import { documentsOutputRow } from '@shared/plugins/documents';
import { testRuntime } from '@test/support/testProcessRuntime';
import { waitForCondition } from '@test/support/asyncTestUtils';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { TexraStateKey } from '@texra/shared/settingsView/texraSettings';
import type * as VSCode from 'vscode';

const mocks = vi.hoisted(() => ({
  diagnosticCollections: [] as Array<{
    readonly items: Map<string, unknown[]>;
    clear: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  registeredProviders: [] as unknown[],
  registerFileDecorationProvider: vi.fn((provider: unknown) => {
    mocks.registeredProviders.push(provider);
    return { dispose: vi.fn() };
  }),
  createDiagnosticCollection: vi.fn(() => {
    const items = new Map<string, unknown[]>();
    const collection = {
      items,
      get: (uri: { fsPath: string }) => items.get(uri.fsPath),
      set: (uri: { fsPath: string }, diagnostics: unknown[]) => {
        items.set(uri.fsPath, diagnostics);
      },
      delete: (uri: { fsPath: string }) => {
        items.delete(uri.fsPath);
      },
      clear: vi.fn(() => items.clear()),
      dispose: vi.fn(),
    };
    mocks.diagnosticCollections.push(collection);
    return collection;
  }),
}));

vi.mock('vscode', () => {
  class Diagnostic {
    source: string | undefined;
    code: string | undefined;

    constructor(
      public range: unknown,
      public message: string,
      public severity: number,
    ) {}
  }

  class EventEmitter<T> {
    event = (_listener: (e: T) => unknown) => ({ dispose: vi.fn() });
    fire(_data: T): void {}
    dispose(): void {}
  }

  return {
    Diagnostic,
    DiagnosticSeverity: {
      Error: 0,
      Warning: 1,
      Information: 2,
      Hint: 3,
    },
    EventEmitter,
    Range: class {
      constructor(
        public startLine: number,
        public startCharacter: number,
        public endLine: number,
        public endCharacter: number,
      ) {}
    },
    ThemeColor: class {
      constructor(public id: string) {}
    },
    Uri: {
      file: (absolutePath: string) => ({
        scheme: 'file',
        fsPath: absolutePath,
        path: absolutePath,
        toString: () => absolutePath,
      }),
    },
    languages: {
      createDiagnosticCollection: mocks.createDiagnosticCollection,
    },
    window: {
      createOutputChannel: (_name: string) => ({
        appendLine: (_text: string) => {},
        append: (_text: string) => {},
        show: () => {},
        dispose: () => {},
      }),
      registerFileDecorationProvider: mocks.registerFileDecorationProvider,
    },
    workspace: {
      getConfiguration: (_section?: string) => ({
        get: <T>(_key: string, defaultValue?: T) => defaultValue,
      }),
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
    },
  };
});

const { createTestSession, publishTestRunStart } =
  await import('@test/support/sessionTestUtils');
const { emitAppSignal } = await import('@eventBus/AppSignals');
const { registerInlineCriticism, syncInlineCriticism } =
  await import('@frontend/latex/inlineCriticism');
const { registerFileDecorations } =
  await import('@frontend/ui/fileDecorations');
const vscode = await import('vscode');

const runId = 'f0a1b2c3d4e5' as RunId;

/** Each emission's output differs, as a new round's does: a documents fact
 *  equal to the one before names no new output. */
let emissions = 0;

async function emitOutputFiles(
  session: SessionHandle,
  absolutePath: string,
): Promise<void> {
  emissions += 1;
  session.publish([
    documentsOutputRow(runId, [
      {
        round: emissions,
        rawOutput: null,
        compileFailures: [],
        missingOutputs: [],
        outputs: [
          {
            source: absolutePath,
            location: {
              kind: 'workspace',
              absolutePath,
              relativePath: absolutePath.split('/').at(-1) ?? absolutePath,
            },
            lineage: null,
            diff: null,
            round: emissions,
          },
        ],
      },
    ]),
  ]);
  await Effect.runPromise(session.settled);
}

/** Diagnostics currently recorded for `absolutePath` in the latest collection. */
function latestDiagnostics(absolutePath: string): unknown[] | undefined {
  return mocks.diagnosticCollections.at(-1)?.items.get(absolutePath);
}

/** The native context only owns frontend disposables. */
function fakeExtensionContext() {
  return { subscriptions: [] };
}

function disposeContext(context: {
  subscriptions: Array<{ dispose(): unknown }>;
}) {
  for (const subscription of context.subscriptions.toReversed()) {
    subscription.dispose();
  }
}

describe('output-file run fact frontend subscriptions', () => {
  let tempDir: string | undefined;

  beforeEach(() => {
    mocks.diagnosticCollections.length = 0;
    mocks.registeredProviders.length = 0;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it.live('badges run-fact output files and app-scoped workspace writes', () =>
    Effect.gen(function* () {
      const session = yield* createTestSession();
      publishTestRunStart(session, runId);
      const context = fakeExtensionContext();
      // The listeners are fibers of this scope, as they are of activation's.
      const scope = yield* Scope.make();
      yield* registerFileDecorations(
        context as unknown as VSCode.ExtensionContext,
        session,
      ).pipe(Scope.provide(scope));
      const provider = mocks.registeredProviders.at(-1) as {
        provideFileDecoration(uri: { scheme: string; fsPath: string }): unknown;
      };
      const texraBadge = { badge: 'T', tooltip: 'Modified by TeXRA' };

      const runFactPath = '/tmp/texra-run-fact-output.tex';
      yield* Effect.promise(() => emitOutputFiles(session, runFactPath));
      expect(
        provider.provideFileDecoration(vscode.Uri.file(runFactPath)),
      ).toMatchObject(texraBadge);

      const writtenPath = '/tmp/texra-workspace-written.tex';
      emitAppSignal('workspaceFilesWritten', {
        absolutePaths: [writtenPath],
      });
      // The badge lands on the subscriber's own fiber, a turn after the publish.
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          expect(
            provider.provideFileDecoration(vscode.Uri.file(writtenPath)),
          ).toMatchObject(texraBadge),
        ),
      );

      yield* Scope.close(scope, Exit.void);
      disposeContext(context);
      expect(
        provider.provideFileDecoration(vscode.Uri.file(writtenPath)),
      ).toBeUndefined();
    }),
  );

  it.live(
    'refreshes inline criticism only for live output rows while enabled',
    () =>
      Effect.gen(function* () {
        tempDir = `/tmp/texra-inline-criticism-${Date.now()}`;
        const outputPath = join(tempDir, 'out.tex');
        yield* Effect.promise(() => mkdir(tempDir!, { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(
            outputPath,
            'before\n\\criticize{tighten this argument}{4}{5}\nafter\n',
          ),
        );

        const session = yield* createTestSession();
        publishTestRunStart(session, runId);
        const context = fakeExtensionContext();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => disposeContext(context)),
        );
        const { stores, globalState } = makeFakeSettingsStores();
        const setEnabled = (enabled: boolean) =>
          globalState
            .update(TexraStateKey.INLINE_CRITICISM_ENABLED, enabled)
            .pipe(Effect.andThen(syncInlineCriticism()));
        yield* registerInlineCriticism(
          context as unknown as VSCode.ExtensionContext,
          testRuntime(),
          session,
          stores,
        );

        yield* Effect.promise(() => emitOutputFiles(session, outputPath));
        yield* setEnabled(true);
        expect(latestDiagnostics(outputPath)).toBe(undefined);

        yield* Effect.promise(() => emitOutputFiles(session, outputPath));
        yield* Effect.promise(() =>
          waitForCondition(
            () => (latestDiagnostics(outputPath) ?? []).length > 0,
            {
              timeoutMs: 200,
              timeoutMessage: 'inline criticism diagnostics were not refreshed',
            },
          ),
        );
        expect(latestDiagnostics(outputPath)).toHaveLength(1);

        yield* setEnabled(false);
        yield* Effect.promise(() => emitOutputFiles(session, outputPath));
        expect(latestDiagnostics(outputPath)).toBe(undefined);
      }),
  );
});
