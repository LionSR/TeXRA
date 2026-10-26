import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Stream, SubscriptionRef } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { AppState } from '@platform/interfaces';
import { qualifyAggregateId, type RunId } from '@shared/schemas';
import { testSessionOf } from '@test/support/testProcessRuntime';
import {
  pollForCondition,
  waitForCondition,
} from '@test/support/asyncTestUtils';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { publishTestRows } from '@test/support/sessionTestUtils';
import { documentsOutputFact } from '@texra/shared/plugins/documents';
import { TexraStateKey } from '@texra/shared/settingsView/texraSettings';

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
const { followInlineCriticism } =
  await import('@frontend/latex/inlineCriticism');

const runId = 'f0a1b2c3d4e5' as RunId;

/** Each emission's output differs, as a new round's does: a documents fact
 *  equal to the one before names no new output. */
let emissions = 0;

async function emitOutputFiles(
  session: SessionHandle,
  absolutePath: string,
): Promise<void> {
  emissions += 1;
  publishTestRows(session, [
    {
      type: 'plugin.fact',
      aggregateId: qualifyAggregateId('run', runId),
      parent: null,
      ...documentsOutputFact([
        {
          round: emissions,
          compileFailures: [],
          missingOutputs: [],
          latexdiffs: [],
          reply: null,
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
    },
  ]);
  await Effect.runPromise(session.log.settled);
}

/** Diagnostics currently recorded for `absolutePath` in the latest collection. */
function latestDiagnostics(absolutePath: string): unknown[] | undefined {
  return mocks.diagnosticCollections.at(-1)?.items.get(absolutePath);
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
        const { stores, globalState } = makeFakeSettingsStores();
        // The global store's change feed: each write below wakes it, as the
        // database's commit does.
        const writes = yield* SubscriptionRef.make(0);
        const setEnabled = (enabled: boolean) =>
          globalState
            .update(TexraStateKey.INLINE_CRITICISM_ENABLED, enabled)
            .pipe(Effect.andThen(SubscriptionRef.update(writes, (n) => n + 1)));
        yield* Effect.forkScoped(
          followInlineCriticism(testSessionOf(session), stores).pipe(
            Effect.provideService(AppState, {
              get: (key) => globalState.get(key),
              update: (key, value) => globalState.update(key, value),
              modify: (key, change) => globalState.modify(key, change),
              changes: () =>
                SubscriptionRef.changes(writes).pipe(Stream.as(undefined)),
            }),
            Effect.provide(nodePlatformLayer),
          ),
        );

        yield* Effect.promise(() => emitOutputFiles(session, outputPath));
        yield* setEnabled(true);
        expect(latestDiagnostics(outputPath)).toBe(undefined);

        // The follower opens the diagnostics off this fiber, so each new
        // round is written until one lands after it has subscribed.
        let refreshed = false;
        for (let round = 0; round < 40 && !refreshed; round++) {
          yield* Effect.promise(() => emitOutputFiles(session, outputPath));
          refreshed = yield* Effect.promise(() =>
            pollForCondition(
              () => (latestDiagnostics(outputPath) ?? []).length > 0,
              { timeoutMs: 50 },
            ),
          );
        }
        expect(refreshed).toBe(true);
        expect(latestDiagnostics(outputPath)).toHaveLength(1);

        yield* setEnabled(false);
        yield* Effect.promise(() =>
          waitForCondition(
            () =>
              mocks.diagnosticCollections.at(-1)?.dispose.mock.calls.length ===
              1,
            {
              timeoutMs: 2000,
              timeoutMessage: 'inline criticism diagnostics were not closed',
            },
          ),
        );
        yield* Effect.promise(() => emitOutputFiles(session, outputPath));
        expect(latestDiagnostics(outputPath)).toBe(undefined);
        expect(mocks.diagnosticCollections).toHaveLength(1);
      }),
  );
});
